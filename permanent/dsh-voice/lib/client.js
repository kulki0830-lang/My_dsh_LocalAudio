/*!
 * dsh-voice — permanent client half, stage P3 (port of voice-1/pkg-10 client).
 *
 * Loaded as a classic script at /plugins/dsh-voice/client.js; registers with
 * the platform module loader and resolves its externals against the static
 * table ('react' is a seed word). Ported 1:1 from the validated dynamic
 * client; the only rewrites are the three sandbox seams:
 *   1. host.call(method, args)     → fetch() against /api/dsh-voice/* routes
 *   2. styles.insert(CSS)          → owned <style data-plugin> element
 *   3. sandbox React builtin       → require('react') from the module table
 * Everything else — store/useStore, toast queue, CommButton, VoiceSection,
 * slot registrations (names/ids/orders/labels) — is unchanged.
 */
window.__ModuleLoader__.load({
	id: 'dsh-voice',
	external: ['react'],
	factory: function (require) {
		var module = { exports: {} }
		var exports = module.exports
		var React = require('react')

		/** Host route family (the permanent counterpart of the 8 dynamic RPC methods). */
		var API = {
			state: '/api/dsh-voice/state',
			config: '/api/dsh-voice/config',
			model: '/api/dsh-voice/model',
			presets: '/api/dsh-voice/presets',
			presetSelect: '/api/dsh-voice/presets/select',
			service: '/api/dsh-voice/service',
			toggle: '/api/dsh-voice/toggle',
		}
		var HTTP = { state: 'GET', config: 'GET', toggle: 'POST', setService: 'POST', setModel: 'POST', savePreset: 'POST', selectPreset: 'POST', deletePreset: 'DELETE' }
		/** RPC action name → API key (action names and route paths intentionally differ). */
		var PATH_OF = {
			state: 'state',
			config: 'config',
			toggle: 'toggle',
			setService: 'service',
			setModel: 'model',
			savePreset: 'presets',
			deletePreset: 'presets',
			selectPreset: 'presetSelect',
		}

		function call(rpc, args) {
			var verb = HTTP[rpc] || 'POST'
			var url = API[PATH_OF[rpc]]
			if (!url) return Promise.reject(new Error('未知的語音動作: ' + rpc))
			if (verb === 'GET') url += '?t=' + Date.now()
			var init = { method: verb, headers: {} }
			if (verb !== 'GET') {
				init.headers['content-type'] = 'application/json'
				init.body = JSON.stringify(args || {})
			}
			return fetch(url, init).then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status)
				return res.json()
			})
		}

		var name = 'voice'
		var inject = ['slots', 'timer']

		function apply(ctx) {
			var slots = ctx.get('slots')
			if (slots === undefined) return

			var styleEl = null
			function insertStyle(css) {
				if (styleEl) return
				styleEl = document.createElement('style')
				styleEl.setAttribute('data-plugin', 'dsh-voice')
				styleEl.setAttribute('data-plugin-css', 'dsh-voice')
				styleEl.textContent = css
				document.head.append(styleEl)
			}

			var store = {
				state: { serviceState: 'stopped', commState: 'hidden', phase: '', error: '', notice: '', bridgeAlive: false, sessionId: '' },
				cfg: null,
				sessionId: '',
				toast: null,
				toastSeq: 0,
				lastState: null,
				listeners: new Set(),
			}
			function notify() { store.listeners.forEach(function (fn) { try { fn() } catch (e) { } }) }
			function subscribe(fn) { store.listeners.add(fn); return function () { store.listeners.delete(fn) } }
			function useStore() {
				var force = React.useState(0)[1]
				React.useEffect(function () { return subscribe(function () { force(function (v) { return v + 1 }) }) }, [])
				return store
			}
			function showToast(kind, text) {
				var id = ++store.toastSeq
				store.toast = { id: id, kind: kind, text: text }
				notify()
				ctx.timer.timeout(function () { if (store.toast && store.toast.id === id) { store.toast = null; notify() } }, 5000)
			}
			var REASON_TEXT = {
				'service-stopped': '語音服務未執行——請先在設定頁啟動',
				'busy': '已有一輪語音進行中',
				'no-session': '找不到目前對話（請先開啟一個對話再使用語音）',
				'no-process': '語音橋接無法啟動',
				'bridge-write-failed': '語音橋接寫入失敗',
				'not-listening': '目前不是收音狀態',
				'not-speaking': '目前沒有可停止的播報',
				'need-clone': '此 TTS 模型需要克隆音色：請先在設定頁保存並選擇預設',
			}
			function act(rpc, args) {
				return call(rpc, args || {}).then(function (res) {
					poll()
					if (res && res.ok === false) {
						var msg = REASON_TEXT[res.reason] || res.error || '動作失敗'
						showToast('error', msg)
					}
					return res
				}).catch(function (e) {
					showToast('error', (e && e.message) || '連線失敗')
					return undefined
				})
			}
			function poll() {
				call('state').then(function (s) {
					if (s && typeof s === 'object') {
						var prev = store.lastState || {}
						if (s.notice && s.notice !== prev.notice) showToast('info', s.notice)
						if (s.error && s.error !== prev.error) showToast('error', s.error)
						store.lastState = s
						store.state = s
						notify()
					}
				}).catch(function () { })
			}
			function refreshCfg() {
				call('config').then(function (c) {
					if (c && typeof c === 'object') { store.cfg = c; notify() }
				}).catch(function () { })
			}
			ctx.effect(function () { return ctx.timer.interval(poll, 700) })

			var COMM_TEXT = { hidden: '開始語音對話', blue: '停止收音／辨識', orange: '停止播報' }

			function MicIcon() {
				return React.createElement('span', { className: 'vc-mic', 'aria-hidden': true },
					React.createElement('span', { className: 'vc-mic-capsule' }),
					React.createElement('span', { className: 'vc-mic-arc' }),
					React.createElement('span', { className: 'vc-mic-stem' }),
					React.createElement('span', { className: 'vc-mic-base' }),
				)
			}
			function StopIcon() {
				return React.createElement('span', { className: 'vc-stop', 'aria-hidden': true })
			}

			function CommButton(props) {
				var st = useStore()
				var sid = props && props.sessionId
				React.useEffect(function () { if (sid) store.sessionId = String(sid) }, [sid])
				var c = st.state.commState
				var busy = c === 'blue' || c === 'orange'
				return React.createElement('button', {
					className: 'vc-comm-btn',
					onClick: function () { act('toggle', { sessionId: store.sessionId }) },
					title: COMM_TEXT[c] || '即時語音',
					'aria-label': '即時語音：' + (COMM_TEXT[c] || ''),
				},
					busy ? StopIcon() : MicIcon(),
					c === 'blue' ? React.createElement('span', { className: 'vc-dot vc-dot-blue' }) : null,
					c === 'orange' ? React.createElement('span', { className: 'vc-dot vc-dot-orange' }) : null,
				)
			}

			function Card(title, children) {
				return React.createElement('section', { className: 'vc-card' },
					React.createElement('h3', { className: 'vc-card-title' }, title),
					children,
				)
			}

			function VoiceSection(props) {
				var st = useStore()
				React.useEffect(function () { refreshCfg() }, [])
				var cfg = st.cfg
				var s = st.state

				var vp = React.useState('')
				var voicePath = vp[0], setVoicePath = vp[1]
				var tp = React.useState('')
				var textPath = tp[0], setTextPath = tp[1]
				var mg = React.useState('')
				var saveMsg = mg[0], setSaveMsg = mg[1]
				var cd = React.useState('')
				var confirmDelete = cd[0], setConfirmDelete = cd[1]

				if (!cfg) {
					return React.createElement('div', { className: 'vc-page' }, '載入中…')
				}
				var set = cfg.settings
				var opts = cfg.options || { tts: [], asr: [] }
				var running = s.serviceState === 'running'

				function selOption(value, label) { return React.createElement('option', { value: value }, label) }

				var serviceCard = Card('服務控制', [
					React.createElement('div', { className: 'vc-row', key: 'badge' },
						React.createElement('span', { className: 'vc-badge-dot ' + (running ? 'vc-dot-green' : 'vc-dot-gray') }),
						React.createElement('span', null, running ? '服務就緒（運行中）' : '已卸載（停用中）'),
						React.createElement('button', {
							className: 'vc-btn vc-btn-primary', style: { marginLeft: 'auto' },
							onClick: function () { act('setService', { to: running ? 'stopped' : 'running' }).then(refreshCfg) },
						}, running ? '卸載' : '執行'),
					),
					s.error ? React.createElement('div', { className: 'vc-error', key: 'err' }, s.error) : null,
				])

				var modelCard = Card('模型配置', [
					React.createElement('label', { className: 'vc-field', key: 'tts' },
						React.createElement('span', { className: 'vc-field-label' }, 'TTS 模型（下一輪生效）'),
						React.createElement('select', {
							value: set.ttsModel,
							onChange: function (e) { act('setModel', { kind: 'tts', id: e.target.value }).then(refreshCfg) },
						}, opts.tts.map(function (id) { return selOption(id, id) })),
					),
					React.createElement('label', { className: 'vc-field', key: 'asr' },
						React.createElement('span', { className: 'vc-field-label' }, 'ASR 模型（下一輪生效）'),
						React.createElement('select', {
							value: set.asrModel,
							onChange: function (e) { act('setModel', { kind: 'asr', id: e.target.value }).then(refreshCfg) },
						}, opts.asr.map(function (id) { return selOption(id, id) })),
					),
				])

				var cloneCard = Card('克隆音色配置', [
					React.createElement('div', { className: 'vc-field', key: 'pick' },
						React.createElement('span', { className: 'vc-field-label' }, '使用中的預設'),
						React.createElement('select', {
							value: set.activePresetId || '',
							onChange: function (e) { act('selectPreset', { presetId: e.target.value || null }).then(refreshCfg) },
						},
							selOption('', '（無——使用內建音色 Vivian）'),
							(set.presets || []).map(function (p) { return selOption(p.id, p.voice.label + ' ＋ ' + p.text.label) }),
						),
					),
					React.createElement('label', { className: 'vc-field', key: 'vp' },
						React.createElement('span', { className: 'vc-field-label' }, '參考音色（WAV 路徑）'),
						React.createElement('input', {
							className: 'vc-input', type: 'text', value: voicePath,
							placeholder: 'D:/path/to/voice.wav',
							onChange: function (e) { setVoicePath(e.target.value) },
						}),
					),
					React.createElement('label', { className: 'vc-field', key: 'tp' },
						React.createElement('span', { className: 'vc-field-label' }, '參考文本（UTF-8 文字檔路徑；內容需與音檔逐字一致）'),
						React.createElement('input', {
							className: 'vc-input', type: 'text', value: textPath,
							placeholder: 'D:/path/to/voicetext.txt',
							onChange: function (e) { setTextPath(e.target.value) },
						}),
					),
					React.createElement('div', { className: 'vc-row', key: 'actions' },
						React.createElement('button', {
							className: 'vc-btn vc-btn-primary',
							onClick: function () {
								act('savePreset', { voicePath: voicePath, textPath: textPath }).then(function (res) {
									setSaveMsg(res && res.ok ? '已保存並套用' : '')
									refreshCfg()
								})
							},
						}, '保存為新預設'),
						(set.presets || []).length === 0 ? React.createElement('span', { className: 'vc-hint', key: 'empty' }, '尚無預設') : null,
					),
					React.createElement('div', { className: 'vc-preset-list', key: 'list' },
						(set.presets || []).map(function (p) {
							var confirming = confirmDelete === p.id
							return React.createElement('div', { className: 'vc-preset-row', key: p.id },
								React.createElement('span', { className: 'vc-preset-name', title: p.voice.path + ' ＋ ' + p.text.path }, p.voice.label + ' ＋ ' + p.text.label),
								React.createElement('button', {
									className: 'vc-btn', onClick: function () { setVoicePath(p.voice.path); setTextPath(p.text.path) },
								}, '填入'),
								React.createElement('button', {
									className: 'vc-btn ' + (confirming ? 'vc-btn-danger' : ''),
									onClick: function () {
										if (!confirming) { setConfirmDelete(p.id); return }
										act('deletePreset', { presetId: p.id }).then(function () { setConfirmDelete(''); refreshCfg() })
									},
								}, confirming ? '確認刪除？' : '刪除'),
							)
						}),
					),
					saveMsg ? React.createElement('div', { className: 'vc-hint', key: 'msg' }, saveMsg) : null,
				])

				var diag = cfg.diag || {}
				var diagLine = React.createElement('div', { className: 'vc-diag' },
					'診斷 · agents: ' + (diag.agents ? '✓' : '✗') +
					' · subprocess: ' + (diag.subprocess ? '✓' : '✗') +
					' · fs: ' + (diag.fs ? '✓' : '✗') +
					' · bridge: ' + (diag.bridgeAlive ? '✓' : '✗') +
					' · 目前 agent: ' + (diag.currentAgentFound ? '✓ 已綁定' : '點圓鈕時自動帶入'),
				)

				return React.createElement('div', { className: 'vc-page' },
					serviceCard, modelCard, cloneCard, diagLine,
				)
			}

			function Toast() {
				var st = useStore()
				var t = st.toast
				if (!t || !t.text) return null
				return React.createElement('div', { className: 'vc-toast ' + (t.kind === 'error' ? 'vc-toast-error' : 'vc-toast-info') }, t.text)
			}

			var CSS = "\n.vc-comm-btn { position: relative; width: 44px; height: 44px; flex: 0 0 44px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary); }\n.vc-comm-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }\n.vc-mic { position: relative; width: 18px; height: 22px; display: block; }\n.vc-mic-capsule { position: absolute; left: 5px; top: 0; width: 8px; height: 12px; border-radius: 4px; background: currentColor; }\n.vc-mic-arc { position: absolute; left: 2px; top: 3px; width: 14px; height: 9px; border: 1.5px solid currentColor; border-top: none; border-radius: 0 0 8px 8px; box-sizing: border-box; }\n.vc-mic-stem { position: absolute; left: 8px; top: 12px; width: 2px; height: 4px; background: currentColor; }\n.vc-mic-base { position: absolute; left: 4px; top: 16px; width: 10px; height: 2px; border-radius: 1px; background: currentColor; }\n.vc-stop { width: 14px; height: 14px; border-radius: 3px; background: currentColor; display: block; }\n.vc-dot { position: absolute; top: 3px; right: 3px; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-bg-base, #ffffff); box-sizing: content-box; }\n.vc-dot-blue { background: var(--dsw-alias-brand-primary, #4c8dff); }\n.vc-dot-orange { background: var(--dsw-alias-state-warn-primary, #ffab2e); }\n.vc-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary); font-size: 13px; }\n.vc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }\n.vc-card-title { margin: 0 0 2px; font-size: 13px; font-weight: 600; }\n.vc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n.vc-badge-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }\n.vc-dot-green { background: var(--dsw-alias-state-success-primary, #34c759); }\n.vc-dot-gray { background: var(--dsw-alias-label-secondary); opacity: .55; }\n.vc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n.vc-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.vc-input, .vc-field select { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 6px 8px; font-size: 13px; width: 100%; box-sizing: border-box; }\n.vc-btn { padding: 5px 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12.5px; white-space: nowrap; }\n.vc-btn:hover { background: var(--dsw-alias-bg-overlay); }\n.vc-btn-primary { background: var(--dsw-alias-brand-primary, #4c8dff); border-color: transparent; color: #ffffff; font-weight: 600; }\n.vc-btn-danger { border-color: var(--dsw-alias-state-error-primary, #ff453a); color: var(--dsw-alias-state-error-primary, #ff453a); }\n.vc-preset-list { display: flex; flex-direction: column; gap: 6px; }\n.vc-preset-row { display: flex; align-items: center; gap: 8px; }\n.vc-preset-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }\n.vc-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.vc-error { font-size: 12.5px; color: var(--dsw-alias-state-error-primary, #ff453a); word-break: break-word; }\n.vc-diag { font-size: 11.5px; color: var(--dsw-alias-label-secondary); padding: 0 2px; }\n.vc-toast { position: fixed; right: 20px; bottom: 96px; z-index: 9999; max-width: 340px; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); box-shadow: 0 6px 24px rgba(0,0,0,.18); }\n.vc-toast-error { border-color: var(--dsw-alias-state-error-primary, #ff453a); }\n"

			ctx.effect(function () {
				insertStyle(CSS)
				return function () {
					if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
					styleEl = null
				}
			})

			slots.inject('conversation.input.right', function () {
				return slots.register(
					{ name: 'conversation.input.right', id: 'comm-toggle', order: -1, label: '即時語音' },
					function (props) { return React.createElement(CommButton, props) },
				)
			})
			slots.inject('settings.section', function () {
				return slots.register(
					{ name: 'settings.section', id: 'voice-control', order: 5, label: '即時語音' },
					function (props) { return React.createElement(VoiceSection, props) },
				)
			})
			slots.inject('shell.overlay', function () {
				return slots.register(
					{ name: 'shell.overlay', id: 'voice-toast', order: 200 },
					function (props) { return React.createElement(Toast, props) },
				)
			})
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
