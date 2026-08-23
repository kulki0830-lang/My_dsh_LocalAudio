/*!
 * voice-1 / pkg-9 Host half — Dynamic Development Baseline (dynamic-baseline-v1.0)
 *
 * 來源：DSH 動態插件 voice-1 之 currentPackageId pkg-9（已驗收）。
 * 重新部署方式（不修改內容，僅按環境調整頂部路徑常數 WS/AUDIOCPP/CURL）：
 *   cordis_define({ kind:'existing', pluginId:'voice-1' }, name, purpose,
 *                 { host: <本檔全文>, client: <pkg-9.client.js 全文> })
 *   cordis_run({ pluginId:'voice-1', packageId:<新 pkg>, mode:'update' })
 * 注意：本檔為「函式主體」，以 return 開頭；不可加 import/require/TS。
 */
return {
  inject: ['subprocess', 'timer', 'fs'],
  apply(ctx) {
    var WS = 'D:/.Apps/deepseek-harness/deepseek 工作區/研究與架構/及時語音互動'
    var RUNTIME = WS + '/dsh_LocalAudio/runtime'
    var SETTINGS_PATH = RUNTIME + '/voice-settings.json'
    var PY = WS + '/LocalAudio_CLI/.assistant-venv/Scripts/python.exe'
    var BRIDGE = RUNTIME + '/voice_bridge.py'
    var AUDIOCPP = 'D:/.Apps/audiocpp'
    var SERVER_EXE = AUDIOCPP + '/bin/audiocpp_server.exe'
    var SERVER_CFG = AUDIOCPP + '/server.json'
    var BIN_DIR = AUDIOCPP + '/bin'
    var LOG_PATH = AUDIOCPP + '/output/api_server.log'
    var ERR_LOG_PATH = AUDIOCPP + '/output/api_server.err.log'
    var SERVER_URL = 'http://127.0.0.1:8081'
    var CURL = 'C:/Windows/System32/curl.exe'
    var TTS_IDS = ['qwen3-tts', 'qwen3-tts-base', 'qwen3-tts-06b-base', 'qwen3-tts-06b-base-bf16', 'qwen3-tts-voicedesign', 'voxcpm2', 'omnivoice']
    var CLONE_TTS = ['qwen3-tts-base', 'qwen3-tts-06b-base', 'qwen3-tts-06b-base-bf16']
    var ASR_IDS = ['sense-asr', 'qwen3-asr']

    var fs = ctx.fs
    var DEFAULTS = { asrModel: 'sense-asr', ttsModel: 'qwen3-tts-06b-base', presets: [], activePresetId: null, voicePrefix: '(Voice) ', maxTtsChars: 0, maxSentenceLen: 80 }

    var state = {
      settings: JSON.parse(JSON.stringify(DEFAULTS)),
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
      ctx.timer.timeout(function () { if (state.notice === msg) state.notice = '' }, 4000)
    }
    function sleep(ms) { return new Promise(function (res) { ctx.timer.timeout(res, ms) }) }
    function ttsCap() {
      var v = state.settings.maxTtsChars
      return (typeof v === 'number' && v > 0) ? v : Infinity
    }

    // ---- 自我檢測 Tool（供 Agent 直接量測子程序環境） ----
    function probeOnce(argv, graceMs) {
      return new Promise(function (resolve) {
        var h
        try {
          h = ctx.subprocess.spawn({ argv: argv, cwd: AUDIOCPP, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 16384 } }, graceMs: graceMs || 8000 })
        } catch (e) { resolve({ spawnError: emsg(e) }); return }
        h.done.then(function (o) {
          var out = '', err = ''
          try { var r = h.collected.stdout; if (r) out = r.readFrom(0).text || '' } catch (e) { }
          try { var r2 = h.collected.stderr; if (r2) err = r2.readFrom(0).text || '' } catch (e) { }
          resolve({ exitCode: o.exitCode, stdout: String(out).slice(0, 200), stderr: String(err).slice(0, 200) })
        }).catch(function (e) { resolve({ waitError: emsg(e) }) })
      })
    }
    var selftestDef = harness.defineTool({
      name: 'voice_selftest',
      description: '診斷語音插件子程序環境：分別以 DSH subprocess 服務 spawn curl 與 python，回報退出碼與輸出，以及 bridge/服務現況。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: function (args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      execute: function () {
        return Promise.all([
          probeOnce([CURL, '-s', '--max-time', '2', SERVER_URL + '/v1/models'], 8000),
          probeOnce([PY, '-c', 'print("bridge-ok")'], 8000),
        ]).then(function (rs) {
          return { curl: rs[0], python: rs[1], bridgeAlive: !!state.bridge, bridgeReady: state.bridgeReady, serviceState: state.serviceState, commState: state.commState }
        })
      },
    })
    ctx.effect(function () { return harness.registerTool(ctx, selftestDef) })

    // ---- 設定持久化(JSON 檔;永久化時移轉 DSH Settings namespace) ----
    async function persistSettings() {
      try {
        var t = await fs.resolve(SETTINGS_PATH)
        await fs.writeText(t, JSON.stringify(state.settings, null, 2))
      } catch (e) { setError('設定保存失敗: ' + emsg(e)) }
    }
    async function loadSettings() {
      try {
        var t = await fs.resolve(SETTINGS_PATH)
        var txt = await fs.readText(t)
        var j = JSON.parse(txt)
        var next = JSON.parse(JSON.stringify(DEFAULTS))
        Object.keys(next).forEach(function (k) { if (j[k] !== undefined) next[k] = j[k] })
        if (!Array.isArray(next.presets)) next.presets = []
        state.settings = next
      } catch (e) { /* 首次啟動尚無設定檔 */ }
    }
    function pubSettings() {
      var s = state.settings
      return { asrModel: s.asrModel, ttsModel: s.ttsModel, presets: s.presets, activePresetId: s.activePresetId, voicePrefix: s.voicePrefix, maxTtsChars: s.maxTtsChars, maxSentenceLen: s.maxSentenceLen }
    }
    function activePreset() {
      var s = state.settings
      for (var i = 0; i < s.presets.length; i++) if (s.presets[i].id === s.activePresetId) return s.presets[i]
      return null
    }

    // ---- bridge 子程序(JSON Lines；HTTP 與 8081 管理都在 bridge 內) ----
    function ensureBridge() {
      if (state.bridge) return state.bridge
      var h
      try {
        h = ctx.subprocess.spawn({
          argv: [PY, '-u', BRIDGE], cwd: RUNTIME,
          stdio: { stdin: 'pipe', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
          graceMs: 3000,
        })
      } catch (e) { setError('啟動語音橋接失敗: ' + emsg(e)); return null }
      state.bridge = h; state.bridgeReady = false
      state.outOffset = 0; state.errOffset = 0; state.lineBuf = ''
      if (h.stdin) h.stdin.on('error', function () { })
      h.done.then(function (outcome) {
        if (state.bridge !== h) return
        state.bridge = null; state.bridgeReady = false
        Object.keys(state.pendingReqs).forEach(function (k) {
          var fn = state.pendingReqs[k]; delete state.pendingReqs[k]
          fn({ ok: false, error: 'bridge 已結束' })
        })
        if (state.round) closeRound()
        var tail = ''
        try { var r = h.collected.stderr; if (r) tail = (r.readFrom(0).text || '').split('\n').filter(Boolean).slice(-2).join(' | ') } catch (e) { }
        setError('語音橋接進程已結束 (exit ' + (outcome.exitCode === null ? 'signal' : outcome.exitCode) + ')' + (tail ? ' · ' + tail : ''))
      }).catch(function (e) {
        if (state.bridge !== h) return
        state.bridge = null; state.bridgeReady = false
        setError('語音橋接進程異常: ' + emsg(e))
      })
      return h
    }
    function bridgeSend(obj) {
      var b = state.bridge
      if (!b || !b.stdin) return false
      try { b.stdin.write(JSON.stringify(obj) + '\n'); return true } catch (e) { return false }
    }
    function callBridgeReq(payload, timeoutMs) {
      return new Promise(function (resolve) {
        if (!state.bridge) { resolve({ ok: false, error: '語音橋接未運行' }); return }
        var req = 'q' + (++state.reqSeq)
        var t = ctx.timer.timeout(function () {
          if (state.pendingReqs[req]) state.pendingReqs[req]({ ok: false, error: '逾時' })
        }, timeoutMs || 25000)
        state.pendingReqs[req] = function (res) {
          delete state.pendingReqs[req]
          try { t() } catch (e) { }
          resolve(res || { ok: false, error: '空回應' })
        }
        payload.req = req
        bridgeSend(payload)
      })
    }
    async function sendConfig() {
      var s = state.settings
      var p = activePreset()
      var refText = ''
      if (p) {
        try { refText = (await fs.readText(await fs.resolve(p.text.path))).trim() } catch (e) { refText = '' }
      }
      return bridgeSend({
        cmd: 'config',
        config: {
          tts: { model: s.ttsModel, language: 'chinese', speaker: p ? '' : 'Vivian', voicePath: p ? p.voice.path : '', referenceText: refText, ttsFamilies: TTS_IDS },
          asr: { model: s.asrModel, language: 'zh' },
          audio: { input_device: null, output_device: null, sample_rate: 16000, max_record_seconds: 30, min_record_seconds: 0.6, silence_seconds: 0.8, silence_threshold: 0.01 },
          server: { exe: SERVER_EXE, cfgPath: SERVER_CFG, port: 8081, binDir: BIN_DIR, logPath: LOG_PATH, errLogPath: ERR_LOG_PATH },
        },
      })
    }

    // ---- 一輪語音互動狀態機(hidden | blue | orange) ----
    function setComm(c) { state.commState = c }
    function closeRound(msg) {
      var r = state.round
      state.round = null
      setComm('hidden')
      if (r && r.watchdog) { try { r.watchdog() } catch (e) { } }
      if (msg) setNotice(msg)
    }
    function cleanForTts(text) {
      var t = String(text || '')
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
      var t = seg.replace(/\s+/g, '')
      if (!t) return true
      if (!/[0-9a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return true
      if (t.length <= 4 && !/[aeiouAEIOU\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return true
      return false
    }
    function segToSentences(rawSeg, maxLen) {
      var seg = cleanForTts(rawSeg).replace(/[ \t]+/g, ' ').trim()
      if (!seg) return []
      var parts = []
      while (seg.length > maxLen) {
        var head = seg.slice(0, maxLen)
        var cut = -1
        for (var i = head.length - 1; i >= Math.floor(maxLen * 0.4); i--) {
          if ('，,、：:'.indexOf(head[i]) >= 0) { cut = i + 1; break }
        }
        if (cut <= 0) cut = maxLen
        parts.push(seg.slice(0, cut).trim())
        seg = seg.slice(cut).trim()
      }
      if (seg) parts.push(seg)
      return parts.filter(function (p) { return p && !isNoise(p) })
    }
    async function startRound(sessionId) {
      if (state.serviceState !== 'running') { setNotice('語音服務未執行——請先在設定頁啟動'); return { ok: false, reason: 'service-stopped' } }
      if (state.round) return { ok: false, reason: 'busy' }
      var s = state.settings
      var p = activePreset()
      if (CLONE_TTS.indexOf(s.ttsModel) >= 0) {
        if (!p) return { ok: false, reason: 'need-clone', missing: 'preset' }
        var ref = ''
        try { ref = (await fs.readText(await fs.resolve(p.text.path))).trim() } catch (e) { ref = '' }
        if (!ref) return { ok: false, reason: 'need-clone', missing: 'text' }
        try { var vs = await fs.stat(await fs.resolve(p.voice.path)); if (!vs) return { ok: false, reason: 'need-clone', missing: 'voice' } } catch (e) { return { ok: false, reason: 'need-clone', missing: 'voice' } }
      }
      if (sessionId) state.sessionId = String(sessionId)
      if (!state.sessionId) return { ok: false, reason: 'no-session' }
      var b = ensureBridge()
      if (!b) return { ok: false, reason: 'no-process' }
      if (!state.bridgeReady) {
        for (var i = 0; i < 20; i++) { await sleep(250); if (state.bridgeReady) break }
        if (!state.bridgeReady) return { ok: false, reason: 'no-process' }
      }
      await sendConfig()
      var r = {
        id: 'rnd-' + Date.now(), jobId: 'rec-' + Date.now(), msgId: '', turn: null,
        raw: '', pos: 0, seq: 0, spokenLen: 0, startedSpeaking: false,
        suppressTts: false, phase: 'listening', watchdog: null,
      }
      state.round = r
      setComm('blue')
      setError('')
      if (!bridgeSend({ cmd: 'record', jobId: r.jobId })) { closeRound(); return { ok: false, reason: 'bridge-write-failed' } }
      // 收音期間預熱 TTS 模型：把懶載入時間藏在使用者說話的時間內
      bridgeSend({ cmd: 'ensure-single', model: s.ttsModel, warm: true })
      r.watchdog = ctx.timer.timeout(function () { if (state.round === r && r.phase === 'listening') closeRound('收音逾時') }, 90000)
      return { ok: true, commState: state.commState }
    }
    function cancelAsr() {
      var r = state.round
      if (!r || r.phase !== 'listening') return { ok: false, reason: 'not-listening' }
      bridgeSend({ cmd: 'stop-record' })
      ctx.timer.timeout(function () { if (state.round === r && r.phase === 'listening') closeRound() }, 1500)
      return { ok: true }
    }
    function stopPlayback() {
      var r = state.round
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
      r.watchdog = ctx.timer.timeout(function () { if (state.round === r && r.phase === 'speaking') closeRound('播放逾時') }, 900000)
    }
    function dispatchSentences(r, arr) {
      var cap = ttsCap()
      var sentAny = false
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i]
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
    function feedStream(r) {
      if (r.suppressTts) return
      var maxLen = state.settings.maxSentenceLen || 80
      var sentAny = false
      while (true) {
        var m = /[。！？!?；;\n]/.exec(r.raw.slice(r.pos))
        if (!m) break
        var end = r.pos + m.index + 1
        var seg = r.raw.slice(r.pos, end)
        r.pos = end
        sentAny = dispatchSentences(r, segToSentences(seg, maxLen)) || sentAny
      }
      return sentAny
    }
    function onAsrFinal(jobId, text) {
      var r = state.round
      if (!r || r.jobId !== jobId) return
      if (!text) { closeRound('沒有聽到聲音'); return }
      var agents = ctx.get('agents')
      var agent = (agents && state.sessionId) ? agents.get(state.sessionId) : undefined
      if (!agent || typeof agent.followup !== 'function') { setError('找不到目前對話的 agent（sessionId: ' + state.sessionId + '）'); closeRound(); return }
      r.phase = 'thinking'
      setComm('orange')
      if (r.watchdog) { try { r.watchdog() } catch (e) { } }
      r.watchdog = ctx.timer.timeout(function () { if (state.round === r && r.phase === 'thinking') closeRound('等待回覆逾時') }, 240000)
      var msgId = 'voice-' + Date.now() + '-' + Math.floor(Math.random() * 1e9)
      r.msgId = msgId
      try {
        agent.followup({ id: msgId, role: 'user', content: [{ type: 'text', text: (state.settings.voicePrefix || '') + text }], source: { kind: 'user' } })
      } catch (e) { setError('注入目前對話失敗: ' + emsg(e)); closeRound() }
    }
    function onTurnEnd(reason) {
      var r = state.round
      if (!r) return
      var kind = reason && reason.kind
      if (r.watchdog) { try { r.watchdog() } catch (e) { } ; r.watchdog = null }
      if (r.suppressTts) { closeRound('已停止播報'); return }
      var speakableTail = kind === 'completed' || kind === 'max-tokens' || kind === 'interrupted'
      var spokeSomething = r.startedSpeaking
      if (speakableTail) {
        var tail = r.raw.slice(r.pos)
        r.pos = r.raw.length
        spokeSomething = dispatchSentences(r, segToSentences(tail, state.settings.maxSentenceLen || 80)) || spokeSomething
      }
      if (!spokeSomething) {
        closeRound(!speakableTail && kind && kind !== 'completed' && kind !== 'max-tokens' ? ('回覆未完成(' + kind + ')，不播報') : '回覆沒有可朗讀的內容')
        return
      }
      // 已有句子在隊列/播放中；playback-drained 事件會收圓
    }

    // ---- 事件:message→turn 關聯 + 串流文本→逐句派發 ----
    ctx.on('agent/inbox/claimed', function (payload) {
      try {
        var r = state.round
        if (!r || !r.msgId || !payload || !payload.message) return
        if (String(payload.message.id) !== String(r.msgId)) return
        if (payload.agent && state.sessionId && String(payload.agent.id) !== String(state.sessionId)) return
        r.turn = payload.turn
      } catch (e) { }
    })
    ctx.on('session/event', function (session, ev) {
      try {
        var r = state.round
        if (!r || !session || !ev) return
        if (String(session.id) !== String(state.sessionId)) return
        var d = ev.data || {}
        if (ev.type === 'assistant/chunk') {
          if (r.turn == null || d.turn !== r.turn) return
          var ch = d.chunk
          if (!ch || ch.type !== 'text-delta' || typeof ch.text !== 'string') return
          r.raw += ch.text
          feedStream(r)
          return
        }
        if (ev.type === 'turn/end' && d.turn === r.turn) onTurnEnd(d.reason)
      } catch (e) { }
    })

    // ---- bridge 事件處理 ----
    function applyModelOptions(ids) {
      var tts = TTS_IDS.slice()
      var asr = ASR_IDS.slice()
      ;(ids || []).forEach(function (id) {
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
        var alive = ev.alive === true
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
        var fn = ev.req ? state.pendingReqs[ev.req] : null
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
      if (ev.event === 'asr-cancelled') { var r0 = state.round; if (r0 && r0.jobId === ev.jobId) closeRound(); return }
      if (ev.event === 'playback-drained' || ev.event === 'playback-stopped') { var r1 = state.round; if (r1 && r1.phase === 'speaking') closeRound(); return }
      if (ev.event === 'error') {
        setError((ev.stage ? ev.stage + ': ' : '') + (ev.message || '未知錯誤'))
        var r2 = state.round
        if (r2 && (r2.jobId === ev.jobId || ev.stage === 'record')) closeRound()
        return
      }
    }
    function drainOutput() {
      var b = state.bridge
      if (!b || !b.collected) return
      try {
        var so = b.collected.stdout
        if (so) {
          var rd = so.readFrom(state.outOffset)
          state.outOffset = rd.nextOffset
          if (rd.text) {
            var chunks = (state.lineBuf + rd.text).split('\n')
            state.lineBuf = chunks.pop() || ''
            for (var i = 0; i < chunks.length; i++) {
              var line = chunks[i].replace(/\r/g, '').trim()
              if (!line) continue
              try { onBridgeEvent(JSON.parse(line)) } catch (e) { }
            }
          }
        }
        var se = b.collected.stderr
        if (se) {
          var rd2 = se.readFrom(state.errOffset)
          state.errOffset = rd2.nextOffset
          if (rd2.text && rd2.text.trim()) console.error('[voice-bridge]', rd2.text.trim())
        }
      } catch (e) { }
    }

    // ---- 服務管理（全部經 bridge） ----
    async function startService() {
      if (state.serviceState === 'running') return { ok: true, serviceState: 'running' }
      var b = ensureBridge()
      if (!b) return { ok: false, error: state.error || '語音橋接無法啟動' }
      for (var i = 0; i < 24; i++) { await sleep(250); if (state.bridgeReady) break }
      if (!state.bridgeReady) return { ok: false, error: '語音橋接未就緒' }
      await sendConfig()
      var res = await callBridgeReq({ cmd: 'start-server' }, 40000)
      if (res && res.ok) return { ok: true, serviceState: 'running' }
      return { ok: false, error: (res && (res.error || res.message)) || '啟動失敗' }
    }
    async function stopService() {
      var hadRound = !!state.round
      if (state.round) { bridgeSend({ cmd: 'stop-record' }); bridgeSend({ cmd: 'stop-playback' }); closeRound('服務卸載，本輪語音已中止') }
      if (!state.bridge) {
        if (state.serviceState === 'stopped') return { ok: true, serviceState: 'stopped' }
        return { ok: false, error: '語音橋接未運行，無法停止 8081' }
      }
      var res = await callBridgeReq({ cmd: 'stop-server' }, 20000)
      bridgeSend({ cmd: 'quit' })
      var b = state.bridge
      ctx.timer.timeout(function () { if (state.bridge === b && b) { try { b.terminate() } catch (e) { } } }, 2500)
      state.serviceState = 'stopped'
      setNotice(hadRound ? '服務已卸載（資源釋放）' : '服務已卸載')
      if (res && !res.ok) return { ok: false, error: res.message || '停止失敗' }
      return { ok: true, serviceState: 'stopped' }
    }

    // ---- RPC(Client→Host) ----
    ctx.effect(function () { return harness.handle('state', async function () {
      return { serviceState: state.serviceState, commState: state.commState, phase: state.round ? state.round.phase : '', error: state.error, notice: state.notice, bridgeAlive: !!state.bridge, sessionId: state.sessionId }
    }) })
    ctx.effect(function () { return harness.handle('getVoiceConfig', async function () {
      var agents = ctx.get('agents')
      var agent = (agents && state.sessionId) ? agents.get(state.sessionId) : undefined
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
    }) })
    ctx.effect(function () { return harness.handle('setModel', async function (a) {
      var kind = a && a.kind, id = String((a && a.id) || '').trim()
      if ((kind !== 'tts' && kind !== 'asr') || !id) return { ok: false, error: '參數不正確' }
      var field = kind === 'tts' ? 'ttsModel' : 'asrModel'
      var cur = state.settings[field]
      state.settings[field] = id
      await persistSettings()
      if (cur && cur !== id && state.bridge && state.serviceState === 'running') bridgeSend({ cmd: 'unload', ids: [cur] })
      if (state.bridge) sendConfig()
      return { ok: true, settings: pubSettings() }
    }) })
    ctx.effect(function () { return harness.handle('savePreset', async function (a) {
      var vp = String((a && a.voicePath) || '').trim()
      var tp = String((a && a.textPath) || '').trim()
      if (!vp || !tp) return { ok: false, error: '音檔與文本路徑皆為必填' }
      try { var vs = await fs.stat(await fs.resolve(vp)); if (!vs) throw new Error('not found') } catch (e) { return { ok: false, error: '音檔不可讀: ' + vp } }
      var ref = ''
      try { ref = (await fs.readText(await fs.resolve(tp))).trim() } catch (e) { return { ok: false, error: '文本檔不可讀: ' + tp } }
      if (!ref) return { ok: false, error: '文本內容為空白（UTF-8）' }
      function baseName(p) { var parts = p.split(/[\\/]/); return parts[parts.length - 1] || p }
      var ts = Date.now()
      var pair = { id: 'p' + ts, voice: { id: 'v' + ts, label: baseName(vp), path: vp }, text: { id: 't' + ts, label: baseName(tp), path: tp } }
      state.settings.presets.push(pair)
      state.settings.activePresetId = pair.id
      await persistSettings()
      if (state.bridge) sendConfig()
      return { ok: true, presets: state.settings.presets, activePresetId: pair.id }
    }) })
    ctx.effect(function () { return harness.handle('deletePreset', async function (a) {
      var pid = a && a.presetId
      var before = state.settings.presets.length
      state.settings.presets = state.settings.presets.filter(function (p) { return p.id !== pid })
      if (state.settings.presets.length === before) return { ok: false, error: '找不到預設' }
      if (state.settings.activePresetId === pid) state.settings.activePresetId = null
      await persistSettings()
      if (state.bridge) sendConfig()
      return { ok: true, presets: state.settings.presets, activePresetId: state.settings.activePresetId }
    }) })
    ctx.effect(function () { return harness.handle('selectPreset', async function (a) {
      var pid = a && a.presetId
      state.settings.activePresetId = pid || null
      await persistSettings()
      if (state.bridge) sendConfig()
      return { ok: true, activePresetId: state.settings.activePresetId }
    }) })
    ctx.effect(function () { return harness.handle('setService', async function (a) {
      if ((a && a.to) === 'running') return startService()
      return stopService()
    }) })
    ctx.effect(function () { return harness.handle('toggle', async function (a) {
      return toggleComm(a && a.sessionId)
    }) })

    // ---- 生命週期 ----
    ctx.effect(function () { return ctx.timer.interval(drainOutput, 200) })
    ctx.effect(function () { return ctx.timer.interval(function () {
      if (state.bridge) bridgeSend({ cmd: 'health' })
      else if (!state.round) ensureBridge()
    }, 5000) })
    ctx.effect(function () {
      var proc = state.bridge
      state.bridge = null
      var rnd = state.round
      state.round = null
      if (rnd && rnd.watchdog) { try { rnd.watchdog() } catch (e) { } }
      if (proc) { try { proc.terminate() } catch (e) { } }
    })

    loadSettings().then(function () { ensureBridge() })
  },
}
