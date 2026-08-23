# 開發環境與重建指南

> 對象：要在自己的機器上重新跑起這個 Dynamic Plugin 的開發者。

## 1. 外部依賴(不在本 repo 內)

| 依賴 | 用途 | 本基線的參考位置 |
|---|---|---|
| audiocpp_server | ASR/TTS 引擎(:8081,懶載入模型) | `D:/.Apps/audiocpp/bin/audiocpp_server.exe`,config `server.json` |
| 模型檔 | qwen3-tts 家族 + sense-asr/qwen3-asr | `D:/.Apps/audiocpp/bin/models/`(8GB 卡建議 0.6B TTS+0.6B ASR) |
| venv python | 執行 bridge(numpy/sounddevice/requests) | `LocalAudio_CLI/.assistant-venv/Scripts/python.exe` |
| 克隆參考檔(選用) | voice.wav + 逐字文本 voicetext.txt | 任意本機路徑;於設定頁保存為預設 |

路徑全部集中定義在 [`plugin/voice-1/pkg-9.host.js`](../plugin/voice-1/pkg-9.host.js) 頂部常數
(`WS/RUNTIME/PY/BRIDGE/AUDIOCPP/SERVER_URL/CURL`)——換環境先改這裡。

## 2. 部署動態插件

1. DSH Web GUI(http://127.0.0.1:3080)中對 agent 說:以 existing pluginId `voice-1`
   (或新 plugin)define 一個 Package,host/client 分別貼入兩個 js 檔**全文**。
2. 核准 run(GUI 出現 ✓)。首次核准僅授權該 Package;雙勾可授權未來版本。
3. 設定頁「即時語音」→ 按「執行」→ 徽章轉綠即 8081 就緒。
4. 對話輸入區右側圓鈕:點擊收音 → 藍點;說完自動辨識注入 → 橘點朗讀;播完復原。

## 3. Bridge 獨立驗證(不需插件)

```powershell
# 全鏈自查:config → 埠探活 → 模型清單 → 一次合成 → 播放排空
<venv-python> runtime/voice_bridge.py --selftest
```

Bridge 由插件 spawn(stdin/stdout JSON Lines);改碼後只需重跑插件讓其重新 spawn,
無需其他註冊。協定細節見 [`docs/Plugin 開發經驗與踩坑紀錄.md`](../docs/Plugin%20開發經驗與踩坑紀錄.md) §5.2。

## 4. 診斷速查

| 症狀 | 先看 |
|---|---|
| 圓鈕無反應/服務起不來 | 設定頁 toast 文案;`api_server.err.log`;`voice_selftest` Tool |
| 克隆 TTS 500 | 預設路徑是否可讀、文本是否逐字、非 ASCII 路徑(bridge 會做 ASCII 副本) |
| 播放亂序/斷音 | bridge 版本是否含 seq 順序鎖;`maxTtsChars` 是否誤設正值 |
| 首輪特別慢 | 模型懶載入(~12s 屬正常);確認預熱命令已發(record 同輪) |

## 5. 已知問題記錄(整理時發現,未修)

依任務約束「只保存、不趁機修」——以下為已知且已記錄的事項:

- `feedStream` 以 `raw.slice(pos)` 掃描,超長文本(萬字級)有 O(n²) 風險(目前長度實測無感)。
- audio.cpp 的 `loaded` 模型旗標在 unload 後可能殘留(HANDOFF 已知,bridge 不信賴此旗標)。
- reasoning-delta 過濾已寫但未以推理模型實測。

## 6. 驗收基準

任何修改後的最小驗收流程見踩坑紀錄 §11;完整 §15 清單見驗收紀錄。
通過後才可 commit;新版本以新 tag(如 `dynamic-baseline-v1.x`)標記。
