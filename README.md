# LocalAudio_CLI — 項目地圖

> 本地語音助手（CLI 版）· 純本地推理 · 一句話入口：**說話 → 聽 → 想 → 邊想邊播**

## 免責聲明

> ⚠️ 本專案為**個人硬體環境客製化的實驗性架構**，僅供個人使用；**不提供維護與 issue 解答**。使用前請自行確認環境相容性，後果自負。

## 這是什麼

一個完全在本地運行的中文語音助手：麥克風收音 → audio.cpp 語音識別（SenseVoice）→ DeepSeek 流式思考 → Qwen3-TTS 逐句合成 → 喇叭邊想邊播。無需任何雲端 TTS 服務，克隆自己的聲音，全程 GPU（RTX 4060 8GB）。

## 目錄結構（地圖）

```
LocalAudio_CLI/
├── voice_stream.py            主程式（麥克風/ASR/大腦/TTS/播放 全流程）
├── assistant_config.json      唯一配置檔（定版參數 + 自訂參考音）
├── .env                       密钥（DEEPSEEK_API_KEY，私有勿外傳）
├── run_stream.bat             啟動（自動確保 8081 server 在跑）
├── setup_assistant.bat        一次性：建 venv + 裝依賴（本包已含 .assistant-venv，備用）
├── reference/
│   ├── voice.wav              預設參考音（可換成你自己的，改配置即可）
│   └── voicetext.txt          參考音轉錄文字（換音檔時同步更新）
├── .assistant-venv/           虛擬環境（Python 3.11 + sounddevice/numpy/requests）
├── README.md                  本文檔（地圖）
├── PROJECT.md                 項目描述（架構/選型/性能）
└── DEVELOPER.md               開發者文檔（模組/契約/擴展點）
```

## 快速開始

```bat
1. 確認 audio.cpp API server(8081) 在跑（run_stream.bat 會自動起）
2. 雙擊 run_stream.bat
3. 按 Enter → 說話 → 停頓自動送出 → 回答邊想邊播
```

## 配置表（assistant_config.json）

| 段 | 欄位 | 預設 | 說明 |
|---|---|---|---|
| `runtime` | `asr_model` | `sense-asr` | 語音識別模型（定版） |
| | `tts_model` | `qwen3-tts-06b-base` | 合成模型（定版，離線整段） |
| | `sentence_tts` | `true` | 逐句流式播放（定版） |
| | `max_sentence_len` | `80` | 無標點超長句硬切上限 |
| | `keep_tags` | `false` | SenseVoice 情緒/事件標籤（預設關，提示隨之隱藏） |
| `audio_cpp` | `voice_ref` | `reference/voice.wav` | **自訂參考音**（換音檔改這裡） |
| | `reference_text` | `@reference/voicetext.txt` | 參考音轉錄；**`@` 開頭＝讀該文字檔**，或直接填字串 |
| `audio` | `input_device` / `output_device` | `null`(自動) | 麥克風/喇叭設備索引 |
| | `max_record_seconds` | `60` | 單次語音輸入上限 |
| | `silence_seconds` | `1.0` | 靜音判定秒數 |
| `llm` | `mode` / `model` | `deepseek` / `deepseek-chat` | 大腦 |
| | `max_tokens` | `120` | 回覆長度上限 |
| `.env` | `DEEPSEEK_API_KEY` | — | **API 金鑰放這裡**（config 的 `api_key` 留空即可，.env 優先） |
| `cloud_tts` | （全部停用） | — | 雲端 TTS 框架殼，key 已清空，不使用 |

## 常用操作

| 操作 | 做法 |
|---|---|
| 換自己的聲音 | 把新音檔（乾淨 10~30s 單人語音）放到 `reference/`，改 `voice_ref`；**用 sense-asr 轉寫它**，把真實轉錄寫進 `reference/voicetext.txt`（逐字一致，否則克隆會怪） |
| 填 API key | 編輯 `.env` 的 `DEEPSEEK_API_KEY`（config 的 `api_key` 不用填） |
| 調麥克風/喇叭 | 改 `audio.input_device/output_device`（0 起索引；`python -c "import sounddevice; print(sounddevice.query_devices())"` 查看） |
| 取消當前輪 | Ctrl+C |
| 清對話記憶 | 對話中輸入 `/new` |
| 查看/切換 TTS/ASR 模型 | `/tts <id>`、`/asr <id>`（定版參數外，仍可臨時切） |
| 關閉逐句流式 | `/stream off`（改回整段） |

## 故障排查

| 症狀 | 處理 |
|---|---|
| 完全沒聲音 | 檢查 `audio.output_device`；跑 `unload_models.bat` 清顯存後重試 |
| 「大腦卡住」 | 等 45s 自動兜底；或重啟 8081（`start_api.bat`） |
| 第一句很慢（7~8s） | 正常：模型冷載入；之後每句 1.3~1.9s 無縫 |
| 克隆聲音怪/偏男聲 | `reference_text` 與音檔不符 → 重新轉寫 |
| server 崩潰 | 重啟 8081；避免 Ctrl+C 硬殺（會留卡住的 live 會話） |

## 依賴（無需手動裝，venv 已內含）

- Python 3.11 · sounddevice · numpy · requests
- audio.cpp 引擎（8081 server，見根目錄 `bin/`）
- ffmpeg（僅 mp3 解碼備用，本地路徑不依賴）

> 本包與外掛側（appendix/voice-plugin）**完全解耦**：獨立配置、獨立 venv、獨立參考音。外掛亂改不會影響本包。
