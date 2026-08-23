/**
 * dsh-voice — permanent host half, stage P2 (full port of voice-1/pkg-10).
 *
 * Ported 1:1 from the validated dynamic plugin; the only rewrites are the
 * three sandbox→permanent seams:
 *   1. harness.handle(method)      → /api/dsh-voice/* webServer routes
 *   2. harness.defineTool/register → @deepseek-ai/dsh-tools defineTool + ctx.tools.register
 *   3. hardcoded workspace paths   → Config fields (schemastery; loader applies defaults)
 * Everything else — round state machine, streaming sentence dispatch, bridge
 * JSON-Lines management, service lifecycle, settings persistence — is the
 * accepted pkg-10 logic unchanged.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import schema from 'schemastery'

/** Stable cordis plugin name. */
const name = 'voice'

/** Host services this plugin requires (agents resolved optionally at runtime). */
const inject = ['webServer', 'subprocess', 'timer', 'fs', 'tools']

/**
 * Deployment config: environment paths and behavioral tunables. Everything
 * carries a working default so zero-config mounts behave like the validated
 * dynamic plugin on this machine.
 */
const Config = schema.object({
  audioCppExe: schema.string().default('D:/.Apps/audiocpp/bin/audiocpp_server.exe'),
  audioCppCfg: schema.string().default('D:/.Apps/audiocpp/server.json'),
  audioCppBinDir: schema.string().default('D:/.Apps/audiocpp/bin'),
  apiServerLog: schema.string().default('D:/.Apps/audiocpp/output/api_server.log'),
  apiServerErrLog: schema.string().default('D:/.Apps/audiocpp/output/api_server.err.log'),
  serverPort: schema.number().default(8081),
  curlExe: schema.string().default('C:/Windows/System32/curl.exe'),
  pythonExe: schema.string().default('D:/.Apps/deepseek-harness/deepseek 工作區/研究與架構/及時語音互動/LocalAudio_CLI/.assistant-venv/Scripts/python.exe'),
  // '' = package assets/voice_bridge.py (resolved relative to this module)
  bridgeScript: schema.string().default(''),
  // Legacy user-settings file carried over from the dynamic plugin era.
  settingsFile: schema.string().default('D:/.Apps/deepseek-harness/deepseek 工作區/研究與架構/及時語音互動/dsh_LocalAudio/runtime/voice-settings.json'),
  silenceSeconds: schema.number().default(0.8),
  silenceThreshold: schema.number().default(0.01),
  sampleRate: schema.number().default(16000),
  minRecordSeconds: schema.number().default(0.6),
  maxRecordSeconds: schema.number().default(30),
  maxSentenceLen: schema.number().default(80),
  maxTtsChars: schema.number().default(0),
  voicePrefix: schema.string().default('(Voice) '),
  listenWatchdogMs: schema.number().default(90000),
  thinkWatchdogMs: schema.number().default(240000),
  speakWatchdogMs: schema.number().default(900000),
  healthIntervalMs: schema.number().default(5000),
  drainIntervalMs: schema.number().default(200),
})

/** Route family prefix. */
const API = {
  ping: '/api/dsh-voice/ping',
  state: '/api/dsh-voice/state',
  config: '/api/dsh-voice/config',
  model: '/api/dsh-voice/model',
  presets: '/api/dsh-voice/presets',
  presetSelect: '/api/dsh-voice/presets/select',
  service: '/api/dsh-voice/service',
  toggle: '/api/dsh-voice/toggle',
}

const TTS_IDS = ['qwen3-tts', 'qwen3-tts-base', 'qwen3-tts-06b-base', 'qwen3-tts-06b-base-bf16', 'qwen3-tts-voicedesign', 'voxcpm2', 'omnivoice']
const CLONE_TTS = ['qwen3-tts-base', 'qwen3-tts-06b-base', 'qwen3-tts-06b-base-bf16']
const ASR_IDS = ['sense-asr', 'qwen3-asr']

const SETTINGS_DEFAULTS = { asrModel: 'sense-asr', ttsModel: 'qwen3-tts-06b-base', presets: [], activePresetId: null, voicePrefix: '(Voice) ', maxTtsChars: 0, maxSentenceLen: 80 }

/** One JSON response with no-referrer hygiene. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Loopback fence: control routes must not serve LAN-exposed deployments. */
function isLoopbackRequest(req) {
  const remote = req.socket && req.socket.remoteAddress
  if (!remote) return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** Read a small JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > 64 * 1024) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Wrap one logic call as a guarded JSON route handler. */
function jsonRoute(path, method, logic) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== method) {
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        return
      }
      try {
        const args = method === 'GET' ? {} : ((await readJsonBody(req)) ?? {})
        const result = await logic(args)
        writeJson(res, 200, result ?? { ok: true })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: (error && error.message) || String(error) })
      }
    },
  }
}

/** Same guard as jsonRoute(), but dispatches to a different logic() per HTTP method
 *  under ONE registered route — needed because webServer.register() dedupes purely
 *  by `path`, so two jsonRoute() calls with the same path (different methods) collide. */
function jsonRouteMulti(path, handlers) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const logic = handlers[req.method]
      if (!logic) {
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        return
      }
      try {
        const args = req.method === 'GET' ? {} : ((await readJsonBody(req)) ?? {})
        const result = await logic(args)
        writeJson(res, 200, result ?? { ok: true })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: (error && error.message) || String(error) })
      }
    },
  }
}

/**
 * Mount the full voice host surface.
 * @param ctx - host plugin context carrying webServer/subprocess/timer/fs/tools.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
function apply(ctx, config) {
  const subprocess = ctx.subprocess
  const fs = ctx.fs

  /** Read one config field with its P1-era fallback (loader normally fills all). */
  function field(key, fallback) {
    const value = (config ?? {})[key]
    return value === undefined || value === null ? fallback : value
  }

  function paths() {
    const bridge = field('bridgeScript', '') ||
      fileURLToPath(new URL('../assets/voice_bridge.py', import.meta.url))
    return {
      audioCppExe: field('audioCppExe', 'D:/.Apps/audiocpp/bin/audiocpp_server.exe').replace(/\\/g, '/'),
      audioCppCfg: field('audioCppCfg', 'D:/.Apps/audiocpp/server.json').replace(/\\/g, '/'),
      audioCppBinDir: field('audioCppBinDir', 'D:/.Apps/audiocpp/bin').replace(/\\/g, '/'),
      apiServerLog: field('apiServerLog', 'D:/.Apps/audiocpp/output/api_server.log').replace(/\\/g, '/'),
      apiServerErrLog: field('apiServerErrLog', 'D:/.Apps/audiocpp/output/api_server.err.log').replace(/\\/g, '/'),
      serverPort: field('serverPort', 8081),
      curlExe: field('curlExe', 'C:/Windows/System32/curl.exe'),
      pythonExe: field('pythonExe', '').replace(/\\/g, '/'),
      bridgeScript: bridge.replace(/\\/g, '/'),
      bridgeCwd: dirname(bridge),
      settingsFile: field('settingsFile', ''),
      silenceSeconds: field('silenceSeconds', 0.8),
      silenceThreshold: field('silenceThreshold', 0.01),
      sampleRate: field('sampleRate', 16000),
      minRecordSeconds: field('minRecordSeconds', 0.6),
      maxRecordSeconds: field('maxRecordSeconds', 30),
      maxSentenceLen: field('maxSentenceLen', 80),
      maxTtsChars: field('maxTtsChars', 0),
      listenWatchdogMs: field('listenWatchdogMs', 90000),
      thinkWatchdogMs: field('thinkWatchdogMs', 240000),
      speakWatchdogMs: field('speakWatchdogMs', 900000),
      healthIntervalMs: field('healthIntervalMs', 5000),
      drainIntervalMs: field('drainIntervalMs', 200),
    }
  }

  const state = {
    settings: JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)),
    serviceState: 'stopped',
    commState: 'hidden',
    sessionId: '',
    round: null,
    bridge: null,
    bridgeReady: false,
    outOffset: 0, errOffset: 0, lineBuf: '',
    error: '', notice: '',
    options: { tts: [], asr: [] },
    pendingReqs: {},
    reqSeq: 0,
  }

  function emsg(e) { return (e && e.message) || String(e) }
  function setError(msg) { state.error = msg }
  function setNotice(msg) {
    state.notice = msg
    ctx.timer.timeout(() => { if (state.notice === msg) state.notice = '' }, 4000)
  }
  function sleep(ms) { return new Promise((res) => { ctx.timer.timeout(res, ms) }) }
  function ttsCap() {
    const v = state.settings.maxTtsChars
    return (typeof v === 'number' && v > 0) ? v : Infinity
  }

  // ---- self-test tool (agent-facing probe of the spawn environment) ----
  function probeOnce(argv, graceMs) {
    return new Promise((resolve) => {
      let h
      try {
        h = subprocess.spawn({ argv, cwd: paths().audioCppExe.replace(/\/[^/]+$/, ''), stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 16384 } }, graceMs: graceMs || 8000 })
      } catch (e) { resolve({ spawnError: emsg(e) }); return }
      h.done.then((o) => {
        let out = ''
        let err = ''
        try { const r = h.collected.stdout; if (r) out = r.readFrom(0).text || '' } catch (e) { }
        try { const r2 = h.collected.stderr; if (r2) err = r2.readFrom(0).text || '' } catch (e) { }
        resolve({ exitCode: o.exitCode, stdout: String(out).slice(0, 200), stderr: String(err).slice(0, 200) })
      }).catch((e) => { resolve({ waitError: emsg(e) }) })
    })
  }
  const selftestDef = defineTool({
    name: 'voice_selftest',
    description: '診斷語音插件子程序環境：分別以 DSH subprocess 服務 spawn curl 與 python，回報退出碼與輸出，以及 bridge/服務現況。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute() {
      const p = paths()
      return Promise.all([
        probeOnce([p.curlExe, '-s', '--max-time', '2', `http://127.0.0.1:${p.serverPort}/v1/models`], 8000),
        probeOnce([p.pythonExe, '-c', 'print("bridge-ok")'], 8000),
      ]).then((rs) => ({
        curl: rs[0], python: rs[1],
        bridgeAlive: !!state.bridge, bridgeReady: state.bridgeReady,
        serviceState: state.serviceState, commState: state.commState,
      }))
    },
  })
  ctx.effect(() => ctx.tools.register(selftestDef), 'dsh-voice: selftest tool')

  // ---- settings persistence (legacy JSON file; Settings namespace migration is P5) ----
  async function persistSettings() {
    try {
      const t = await fs.resolve(paths().settingsFile)
      await fs.writeText(t, JSON.stringify(state.settings, null, 2))
    } catch (e) { setError('設定保存失敗: ' + emsg(e)) }
  }
  async function loadSettings() {
    const file = paths().settingsFile
    if (!file) return
    try {
      const t = await fs.resolve(file)
      const txt = await fs.readText(t)
      const j = JSON.parse(txt)
      const next = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS))
      Object.keys(next).forEach((k) => { if (j[k] !== undefined) next[k] = j[k] })
      if (!Array.isArray(next.presets)) next.presets = []
      state.settings = next
    } catch (e) { /* first run without a legacy file */ }
  }
  function pubSettings() {
    const s = state.settings
    return { asrModel: s.asrModel, ttsModel: s.ttsModel, presets: s.presets, activePresetId: s.activePresetId, voicePrefix: s.voicePrefix, maxTtsChars: s.maxTtsChars, maxSentenceLen: s.maxSentenceLen }
  }
  function activePreset() {
    const s = state.settings
    for (let i = 0; i < s.presets.length; i++) if (s.presets[i].id === s.activePresetId) return s.presets[i]
    return null
  }

  // ---- resident bridge child process (JSON Lines over stdin/stdout) ----
  function ensureBridge() {
    if (state.bridge) return state.bridge
    const p = paths()
    let h
    try {
      h = subprocess.spawn({
        argv: [p.pythonExe, '-u', p.bridgeScript], cwd: p.bridgeCwd,
        stdio: { stdin: 'pipe', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 3000,
      })
    } catch (e) { setError('啟動語音橋接失敗: ' + emsg(e)); return null }
    state.bridge = h
    state.bridgeReady = false
    state.outOffset = 0; state.errOffset = 0; state.lineBuf = ''
    if (h.stdin) h.stdin.on('error', () => { })
    h.done.then((outcome) => {
      if (state.bridge !== h) return
      state.bridge = null
      state.bridgeReady = false
      Object.keys(state.pendingReqs).forEach((k) => {
        const fn = state.pendingReqs[k]
        delete state.pendingReqs[k]
        fn({ ok: false, error: 'bridge 已結束' })
      })
      if (state.round) closeRound()
      let tail = ''
      try { const r = h.collected.stderr; if (r) tail = (r.readFrom(0).text || '').split('\n').filter(Boolean).slice(-2).join(' | ') } catch (e) { }
      setError('語音橋接進程已結束 (exit ' + (outcome.exitCode === null ? 'signal' : outcome.exitCode) + ')' + (tail ? ' · ' + tail : ''))
    }).catch((e) => {
      if (state.bridge !== h) return
      state.bridge = null
      state.bridgeReady = false
      setError('語音橋接進程異常: ' + emsg(e))
    })
    return h
  }
  function bridgeSend(obj) {
    const b = state.bridge
    if (!b || !b.stdin) return false
    try { b.stdin.write(JSON.stringify(obj) + '\n'); return true } catch (e) { return false }
  }
  function callBridgeReq(payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!state.bridge) { resolve({ ok: false, error: '語音橋接未運行' }); return }
      const req = 'q' + (++state.reqSeq)
      const t = ctx.timer.timeout(() => {
        if (state.pendingReqs[req]) state.pendingReqs[req]({ ok: false, error: '逾時' })
      }, timeoutMs || 25000)
      state.pendingReqs[req] = (res) => {
        delete state.pendingReqs[req]
        try { t() } catch (e) { }
        resolve(res || { ok: false, error: '空回應' })
      }
      payload.req = req
      bridgeSend(payload)
    })
  }
  async function sendConfig() {
    const p = paths()
    const s = state.settings
    const preset = activePreset()
    let refText = ''
    if (preset) {
      try { refText = (await fs.readText(await fs.resolve(preset.text.path))).trim() } catch (e) { refText = '' }
    }
    return bridgeSend({
      cmd: 'config',
      config: {
        tts: { model: s.ttsModel, language: 'chinese', speaker: preset ? '' : 'Vivian', voicePath: preset ? preset.voice.path : '', referenceText: refText, ttsFamilies: TTS_IDS },
        asr: { model: s.asrModel, language: 'zh' },
        audio: { input_device: null, output_device: null, sample_rate: p.sampleRate, max_record_seconds: p.maxRecordSeconds, min_record_seconds: p.minRecordSeconds, silence_seconds: p.silenceSeconds, silence_threshold: p.silenceThreshold },
        server: { exe: p.audioCppExe, cfgPath: p.audioCppCfg, port: p.serverPort, binDir: p.audioCppBinDir, logPath: p.apiServerLog, errLogPath: p.apiServerErrLog },
      },
    })
  }

  // ---- one voice round: hidden | blue | orange ----
  function setComm(c) { state.commState = c }
  function closeRound(msg) {
    const r = state.round
    state.round = null
    setComm('hidden')
    if (r && r.watchdog) { try { r.watchdog() } catch (e) { } }
    if (msg) setNotice(msg)
  }
  function cleanForTts(text) {
    let t = String(text || '')
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    t = t.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    t = t.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/__([^_]*)__/g, '$1')
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
    t = t.replace(/^\s{0,3}[-*+]\s+/gm, '')
    t = t.replace(/^\s{0,3}>\s?/gm, '')
    t = t.replace(/[*_#|]+/g, ' ')
    return t
  }
  function isNoise(seg) {
    const t = seg.replace(/\s+/g, '')
    if (!t) return true
    if (!/[0-9a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return true
    if (t.length <= 4 && !/[aeiouAEIOU\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return true
    return false
  }
  function segToSentences(rawSeg, maxLen) {
    const seg = cleanForTts(rawSeg).replace(/[ \t]+/g, ' ').trim()
    if (!seg) return []
    const parts = []
    while (seg.length > maxLen) {
      const head = seg.slice(0, maxLen)
      let cut = -1
      for (let i = head.length - 1; i >= Math.floor(maxLen * 0.4); i--) {
        if ('，,、：:'.indexOf(head[i]) >= 0) { cut = i + 1; break }
      }
      if (cut <= 0) cut = maxLen
      parts.push(seg.slice(0, cut).trim())
      seg = seg.slice(cut).trim()
    }
    if (seg) parts.push(seg)
    return parts.filter((p) => p && !isNoise(p))
  }
  async function startRound(sessionId) {
    if (state.serviceState !== 'running') { setNotice('語音服務未執行——請先在設定頁啟動'); return { ok: false, reason: 'service-stopped' } }
    if (state.round) return { ok: false, reason: 'busy' }
    const p = paths()
    const s = state.settings
    const preset = activePreset()
    if (CLONE_TTS.indexOf(s.ttsModel) >= 0) {
      if (!preset) return { ok: false, reason: 'need-clone', missing: 'preset' }
      let ref = ''
      try { ref = (await fs.readText(await fs.resolve(preset.text.path))).trim() } catch (e) { ref = '' }
      if (!ref) return { ok: false, reason: 'need-clone', missing: 'text' }
      try { const vs = await fs.stat(await fs.resolve(preset.voice.path)); if (!vs) return { ok: false, reason: 'need-clone', missing: 'voice' } } catch (e) { return { ok: false, reason: 'need-clone', missing: 'voice' } }
    }
    if (sessionId) state.sessionId = String(sessionId)
    if (!state.sessionId) return { ok: false, reason: 'no-session' }
    const b = ensureBridge()
    if (!b) return { ok: false, reason: 'no-process' }
    if (!state.bridgeReady) {
      for (let i = 0; i < 20; i++) { await sleep(250); if (state.bridgeReady) break }
      if (!state.bridgeReady) return { ok: false, reason: 'no-process' }
    }
    await sendConfig()
    const r = {
      id: 'rnd-' + Date.now(), jobId: 'rec-' + Date.now(), msgId: '', turn: null,
      raw: '', pos: 0, seq: 0, spokenLen: 0, startedSpeaking: false,
      suppressTts: false, phase: 'listening', watchdog: null,
    }
    state.round = r
    setComm('blue')
    setError('')
    if (!bridgeSend({ cmd: 'record', jobId: r.jobId })) { closeRound(); return { ok: false, reason: 'bridge-write-failed' } }
    // Warm the TTS model during listening: hide lazy-load inside user speech.
    bridgeSend({ cmd: 'ensure-single', model: s.ttsModel, warm: true })
    r.watchdog = ctx.timer.timeout(() => { if (state.round === r && r.phase === 'listening') closeRound('收音逾時') }, p.listenWatchdogMs)
    return { ok: true, commState: state.commState }
  }
  function cancelAsr() {
    const r = state.round
    if (!r || r.phase !== 'listening') return { ok: false, reason: 'not-listening' }
    bridgeSend({ cmd: 'stop-record' })
    ctx.timer.timeout(() => { if (state.round === r && r.phase === 'listening') closeRound() }, 1500)
    return { ok: true }
  }
  function stopPlayback() {
    const r = state.round
    if (!r || (r.phase !== 'thinking' && r.phase !== 'speaking')) return { ok: false, reason: 'not-speaking' }
    r.suppressTts = true
    bridgeSend({ cmd: 'stop-playback' })
    closeRound()
    return { ok: true }
  }
  function toggleComm(sessionId) {
    if (state.commState === 'hidden') return startRound(sessionId)
    if (state.commState === 'blue') return Promise.resolve(cancelAsr())
    return Promise.resolve(stopPlayback())
  }
  function beginSpeaking(r) {
    if (r.startedSpeaking) return
    r.startedSpeaking = true
    r.phase = 'speaking'
    setComm('orange')
    if (r.watchdog) { try { r.watchdog() } catch (e) { } }
    r.watchdog = ctx.timer.timeout(() => { if (state.round === r && r.phase === 'speaking') closeRound('播放逾時') }, paths().speakWatchdogMs)
  }
  function dispatchSentences(r, arr) {
    const cap = ttsCap()
    let sentAny = false
    for (let i = 0; i < arr.length; i++) {
      let s = arr[i]
      if (r.spokenLen >= cap) break
      if (r.spokenLen + s.length > cap) s = s.slice(0, Math.max(0, cap - r.spokenLen)) + '…'
      if (!s || s === '…') break
      bridgeSend({ cmd: 'speak', roundId: r.id, sentenceId: 's' + r.seq, seq: r.seq, text: s })
      r.spokenLen += s.length
      r.seq += 1
      sentAny = true
    }
    if (sentAny) beginSpeaking(r)
    return sentAny
  }
  /**
   * Sentence terminators. CJK strong marks as-is; an English period counts
   * only when it ends a word (letter/digit/closer before it) and is followed
   * by whitespace + a new sentence start (capital/digit/opening quote) — so
   * decimals and URLs stay intact. Abbreviation false positives are filtered
   * in code below (a plain set beats nested-lookbehind regexes).
   */
  const SENT_RE = /[。！？!?；;\n]|(?<=[A-Za-z0-9)\]"”’])\.(?=[ \t]+["'“(\[]?[A-Z0-9])/g
  const ABBREV = new Set(['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Sr', 'Jr', 'vs', 'etc', 'approx'])
  function isAbbrevBoundary(beforeText) {
    const wm = /[A-Za-z]+$/.exec(beforeText)
    if (wm && ABBREV.has(wm[0])) return true
    return /(?:^|[\s("“])(?:e\.g|i\.e)$/i.test(beforeText)
  }
  function feedStream(r) {
    if (r.suppressTts) return
    const maxLen = state.settings.maxSentenceLen || 80
    let sentAny = false
    let scan = r.pos
    for (;;) {
      const rest = r.raw.slice(scan)
      SENT_RE.lastIndex = 0
      const m = SENT_RE.exec(rest)
      if (!m) break
      const abs = scan + m.index
      if (m[0] === '.' && isAbbrevBoundary(r.raw.slice(r.pos, abs))) {
        scan = abs + 1
        continue
      }
      const end = abs + m[0].length
      const seg = r.raw.slice(r.pos, end)
      r.pos = end
      scan = r.pos
      sentAny = dispatchSentences(r, segToSentences(seg, maxLen)) || sentAny
    }
    return sentAny
  }
  function onAsrFinal(jobId, text) {
    const r = state.round
    if (!r || r.jobId !== jobId) return
    if (!text) { closeRound('沒有聽到聲音'); return }
    const agents = ctx.get('agents')
    const agent = (agents && state.sessionId) ? agents.get(state.sessionId) : undefined
    if (!agent || typeof agent.followup !== 'function') { setError('找不到目前對話的 agent（sessionId: ' + state.sessionId + '）'); closeRound(); return }
    r.phase = 'thinking'
    setComm('orange')
    if (r.watchdog) { try { r.watchdog() } catch (e) { } }
    r.watchdog = ctx.timer.timeout(() => { if (state.round === r && r.phase === 'thinking') closeRound('等待回覆逾時') }, paths().thinkWatchdogMs)
    const msgId = 'voice-' + Date.now() + '-' + Math.floor(Math.random() * 1e9)
    r.msgId = msgId
    try {
      agent.followup({ id: msgId, role: 'user', content: [{ type: 'text', text: (state.settings.voicePrefix || '') + text }], source: { kind: 'user' } })
    } catch (e) { setError('注入目前對話失敗: ' + emsg(e)); closeRound() }
  }
  function onTurnEnd(reason) {
    const r = state.round
    if (!r) return
    const kind = reason && reason.kind
    if (r.watchdog) { try { r.watchdog() } catch (e) { }; r.watchdog = null }
    if (r.suppressTts) { closeRound('已停止播報'); return }
    const speakableTail = kind === 'completed' || kind === 'max-tokens' || kind === 'interrupted'
    let spokeSomething = r.startedSpeaking
    if (speakableTail) {
      const tail = r.raw.slice(r.pos)
      r.pos = r.raw.length
      spokeSomething = dispatchSentences(r, segToSentences(tail, state.settings.maxSentenceLen || 80)) || spokeSomething
    }
    if (!spokeSomething) {
      closeRound(!speakableTail && kind && kind !== 'completed' && kind !== 'max-tokens' ? ('回覆未完成(' + kind + ')，不播報') : '回覆沒有可朗讀的內容')
      return
    }
    // Sentences are queued/playing; playback-drained closes the round.
  }

  // ---- events: message→turn correlation + streamed text→sentence dispatch ----
  ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const r = state.round
      if (!r || !r.msgId || !payload || !payload.message) return
      if (String(payload.message.id) !== String(r.msgId)) return
      if (payload.agent && state.sessionId && String(payload.agent.id) !== String(state.sessionId)) return
      r.turn = payload.turn
    } catch (e) { }
  })
  ctx.on('session/event', (session, ev) => {
    try {
      const r = state.round
      if (!r || !session || !ev) return
      if (String(session.id) !== String(state.sessionId)) return
      const d = ev.data || {}
      if (ev.type === 'assistant/chunk') {
        if (r.turn == null || d.turn !== r.turn) return
        const ch = d.chunk
        if (!ch || ch.type !== 'text-delta' || typeof ch.text !== 'string') return
        r.raw += ch.text
        feedStream(r)
        return
      }
      if (ev.type === 'turn/end' && d.turn === r.turn) onTurnEnd(d.reason)
    } catch (e) { }
  })

  // ---- bridge event handling ----
  function applyModelOptions(ids) {
    const tts = TTS_IDS.slice()
    const asr = ASR_IDS.slice()
    ;(ids || []).forEach((id) => {
      if (TTS_IDS.indexOf(id) < 0 && /(voxcpm|omnivoice|tts)/i.test(id)) tts.push(id)
      if (ASR_IDS.indexOf(id) < 0 && /asr/i.test(id)) asr.push(id)
    })
    state.options = { tts: Array.from(new Set(tts)), asr: Array.from(new Set(asr)) }
  }
  function onBridgeEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.event === 'ready') {
      state.bridgeReady = true
      sendConfig()
      bridgeSend({ cmd: 'health' })
      return
    }
    if (ev.event === 'health') {
      const alive = ev.alive === true
      if (alive && state.serviceState !== 'running') {
        state.serviceState = 'running'
        bridgeSend({ cmd: 'models' })
      } else if (!alive && state.serviceState === 'running') {
        state.serviceState = 'stopped'
      }
      return
    }
    if (ev.event === 'models') { applyModelOptions(ev.ids || []); return }
    if (ev.event === 'server-started' || ev.event === 'server-stopped') {
      const fn = ev.req ? state.pendingReqs[ev.req] : null
      if (ev.event === 'server-started') {
        if (ev.ok) { state.serviceState = 'running'; bridgeSend({ cmd: 'models' }); setNotice('語音服務已啟動') }
        else { state.serviceState = 'stopped'; setError('8081 啟動失敗: ' + (ev.message || '未知原因') + '（詳查 api_server.err.log）') }
      } else {
        state.serviceState = 'stopped'
        if (ev.ok) setNotice('服務已卸載（資源釋放）')
        else setError('8081 停止失敗: ' + (ev.message || ''))
      }
      if (fn) fn(ev)
      return
    }
    if (ev.event === 'single-ok' || ev.event === 'unload-ok' || ev.event === 'config-ok' || ev.event === 'recording' || ev.event === 'tts-queued') return
    if (ev.event === 'asr-final') { onAsrFinal(String(ev.jobId || ''), String(ev.text || '')); return }
    if (ev.event === 'asr-cancelled') { const r0 = state.round; if (r0 && r0.jobId === ev.jobId) closeRound(); return }
    if (ev.event === 'playback-drained' || ev.event === 'playback-stopped') { const r1 = state.round; if (r1 && r1.phase === 'speaking') closeRound(); return }
    if (ev.event === 'error') {
      setError((ev.stage ? ev.stage + ': ' : '') + (ev.message || '未知錯誤'))
      const r2 = state.round
      if (r2 && (r2.jobId === ev.jobId || ev.stage === 'record')) closeRound()
      return
    }
  }
  function drainOutput() {
    const b = state.bridge
    if (!b || !b.collected) return
    try {
      const so = b.collected.stdout
      if (so) {
        const rd = so.readFrom(state.outOffset)
        state.outOffset = rd.nextOffset
        if (rd.text) {
          const chunks = (state.lineBuf + rd.text).split('\n')
          state.lineBuf = chunks.pop() || ''
          for (let i = 0; i < chunks.length; i++) {
            const line = chunks[i].replace(/\r/g, '').trim()
            if (!line) continue
            try { onBridgeEvent(JSON.parse(line)) } catch (e) { }
          }
        }
      }
      const se = b.collected.stderr
      if (se) {
        const rd2 = se.readFrom(state.errOffset)
        state.errOffset = rd2.nextOffset
        if (rd2.text && rd2.text.trim()) console.error('[dsh-voice bridge]', rd2.text.trim())
      }
    } catch (e) { }
  }

  // ---- service management (all through the bridge) ----
  async function startService() {
    if (state.serviceState === 'running') return { ok: true, serviceState: 'running' }
    const b = ensureBridge()
    if (!b) return { ok: false, error: state.error || '語音橋接無法啟動' }
    for (let i = 0; i < 24; i++) { await sleep(250); if (state.bridgeReady) break }
    if (!state.bridgeReady) return { ok: false, error: '語音橋接未就緒' }
    await sendConfig()
    const res = await callBridgeReq({ cmd: 'start-server' }, 40000)
    if (res && res.ok) return { ok: true, serviceState: 'running' }
    return { ok: false, error: (res && (res.error || res.message)) || '啟動失敗' }
  }
  async function stopService() {
    const hadRound = !!state.round
    if (state.round) { bridgeSend({ cmd: 'stop-record' }); bridgeSend({ cmd: 'stop-playback' }); closeRound('服務卸載，本輪語音已中止') }
    if (!state.bridge) {
      if (state.serviceState === 'stopped') return { ok: true, serviceState: 'stopped' }
      return { ok: false, error: '語音橋接未運行，無法停止 8081' }
    }
    const res = await callBridgeReq({ cmd: 'stop-server' }, 20000)
    bridgeSend({ cmd: 'quit' })
    const b = state.bridge
    ctx.timer.timeout(() => { if (state.bridge === b && b) { try { b.terminate() } catch (e) { } } }, 2500)
    state.serviceState = 'stopped'
    setNotice(hadRound ? '服務已卸載（資源釋放）' : '服務已卸載')
    if (res && !res.ok) return { ok: false, error: res.message || '停止失敗' }
    return { ok: true, serviceState: 'stopped' }
  }

  // ---- HTTP surface (the permanent counterpart of the 8 dynamic RPC methods) ----
  const routes = [
    jsonRoute(API.ping, 'GET', async () => ({ ok: true, plugin: 'dsh-voice', stage: 'P2', now: new Date().toISOString() })),
    jsonRoute(API.state, 'GET', async () => ({
      serviceState: state.serviceState, commState: state.commState,
      phase: state.round ? state.round.phase : '',
      error: state.error, notice: state.notice,
      bridgeAlive: !!state.bridge, sessionId: state.sessionId,
    })),
    jsonRoute(API.config, 'GET', async () => {
      const agents = ctx.get('agents')
      const agent = (agents && state.sessionId) ? agents.get(state.sessionId) : undefined
      if (state.bridge && state.serviceState === 'running') bridgeSend({ cmd: 'models' })
      return {
        settings: pubSettings(),
        options: state.options,
        diag: {
          agents: agents !== undefined, timer: ctx.get('timer') !== undefined,
          subprocess: ctx.get('subprocess') !== undefined, fs: fs !== undefined,
          currentAgentFound: !!agent,
          bridgeAlive: !!state.bridge, bridgeReady: state.bridgeReady,
        },
      }
    }),
    jsonRoute(API.model, 'POST', async (a) => {
      const kind = a && a.kind
      const id = String((a && a.id) || '').trim()
      if ((kind !== 'tts' && kind !== 'asr') || !id) return { ok: false, error: '參數不正確' }
      const fieldName = kind === 'tts' ? 'ttsModel' : 'asrModel'
      const cur = state.settings[fieldName]
      state.settings[fieldName] = id
      await persistSettings()
      if (cur && cur !== id && state.bridge && state.serviceState === 'running') bridgeSend({ cmd: 'unload', ids: [cur] })
      if (state.bridge) sendConfig()
      return { ok: true, settings: pubSettings() }
    }),
    jsonRouteMulti(API.presets, {
      POST: async (a) => {
        const vp = String((a && a.voicePath) || '').trim()
        const tp = String((a && a.textPath) || '').trim()
        if (!vp || !tp) return { ok: false, error: '音檔與文本路徑皆為必填' }
        try { const vs = await fs.stat(await fs.resolve(vp)); if (!vs) throw new Error('not found') } catch (e) { return { ok: false, error: '音檔不可讀: ' + vp } }
        let ref = ''
        try { ref = (await fs.readText(await fs.resolve(tp))).trim() } catch (e) { return { ok: false, error: '文本檔不可讀: ' + tp } }
        if (!ref) return { ok: false, error: '文本內容為空白（UTF-8）' }
        const baseName = (p) => { const parts = p.split(/[\\/]/); return parts[parts.length - 1] || p }
        const ts = Date.now()
        const pair = { id: 'p' + ts, voice: { id: 'v' + ts, label: baseName(vp), path: vp }, text: { id: 't' + ts, label: baseName(tp), path: tp } }
        state.settings.presets.push(pair)
        state.settings.activePresetId = pair.id
        await persistSettings()
        if (state.bridge) sendConfig()
        return { ok: true, presets: state.settings.presets, activePresetId: pair.id }
      },
      DELETE: async (a) => {
        const pid = a && a.presetId
        const before = state.settings.presets.length
        state.settings.presets = state.settings.presets.filter((p) => p.id !== pid)
        if (state.settings.presets.length === before) return { ok: false, error: '找不到預設' }
        if (state.settings.activePresetId === pid) state.settings.activePresetId = null
        await persistSettings()
        if (state.bridge) sendConfig()
        return { ok: true, presets: state.settings.presets, activePresetId: state.settings.activePresetId }
      },
    }),
    jsonRoute(API.presetSelect, 'POST', async (a) => {
      const pid = a && a.presetId
      state.settings.activePresetId = pid || null
      await persistSettings()
      if (state.bridge) sendConfig()
      return { ok: true, activePresetId: state.settings.activePresetId }
    }),
    jsonRoute(API.service, 'POST', async (a) => {
      if ((a && a.to) === 'running') return startService()
      return stopService()
    }),
    jsonRoute(API.toggle, 'POST', async (a) => toggleComm(a && a.sessionId)),
  ]
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-voice: api routes')

  // ---- lifecycle timers and teardown ----
  ctx.effect(() => ctx.timer.interval(drainOutput, paths().drainIntervalMs), 'dsh-voice: drain interval')
  ctx.effect(() => ctx.timer.interval(() => {
    if (state.bridge) bridgeSend({ cmd: 'health' })
    else if (!state.round) ensureBridge()
  }, paths().healthIntervalMs), 'dsh-voice: health tick')
  ctx.effect(() => {
    const proc = state.bridge
    state.bridge = null
    const rnd = state.round
    state.round = null
    if (rnd && rnd.watchdog) { try { rnd.watchdog() } catch (e) { } }
    if (proc) { try { proc.terminate() } catch (e) { } }
  }, 'dsh-voice: teardown')

  loadSettings().then(() => { ensureBridge() })
}

export { API, apply, Config, inject, name }
