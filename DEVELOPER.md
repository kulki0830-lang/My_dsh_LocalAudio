# DEVELOPER.md — 開發者文檔

> 對象：要改/擴展本包的開發者。先讀 README.md（地圖）與 PROJECT.md（架構）。

## 1. 模組結構（voice_stream.py）

| 函數/物件 | 職責 |
|---|---|
| `STREAM` / `RT` | 運行時設定（RT 覆蓋 STREAM，來源 `assistant_config.json` 的 `runtime`） |
| `Player` | 無縫播放器：`OutputStream` + queue；`feed()` 切 2048 幀補零入隊，`stop()` 等播完+後台關流 |
| `mic_record()` | 麥克風塊生成器（16k s16le）+ 能量 VAD 靜音判句尾 |
| `file_record()` | 測試模式：wav 重採樣 16k 逐塊產出 |
| `stream_asr()` | live ASR：`POST /v1/audio/transcriptions/live`，SSE 收 `transcript.text.delta/done` |
| `cli_asr()` | 帶標籤 ASR（SenseVoice `keep_tags` 走 CLI） |
| `deepseek_chat()` | 整段大腦（守護線程 45s 硬看門狗） |
| `deepseek_stream()` | 流式大腦（SSE）→ 句子切分器 → `sink(sentence)` |
| `sentence_turn()` | 真·流式主流程：大腦線程 + 合成線程 + 播放循環 |
| `synth_audio()` | 合成一句 → `(PCM bytes, rate)`（雲端/離線/SSE 三路） |
| `stream_tts()` | 整段合成+播完（非流式路徑） |
| `cloud_tts()/fish_tts()/openrouter_tts()` | 雲端 TTS（目前停用，框架保留） |
| `_decode_audio()` / `_ref_mime()` | 音頻解碼（WAV/MP3→PCM/原始 PCM）、參考音 MIME 偵測 |

## 2. 資料契約

### 2.1 live ASR（audio.cpp 8081）
```
POST /v1/audio/transcriptions/live?model=sense-asr&sample_rate=16000&channels=1&sample_format=s16le
body = chunked raw PCM（16k s16le mono）；generator 結束＝終止塊
SSE: {"type":"transcript.text.delta","delta":"<增量>"}   ← 欄位是 delta！
     {"type":"transcript.text.done","text":"<全文>"}
     data: [DONE]
```

### 2.2 TTS（audio.cpp 8081，離線模型）
```
POST /v1/audio/speech  {"model":"qwen3-tts-06b-base","input":text,"language":"chinese",
                        "voice_ref":"<wav>","reference_text":"<逐字轉錄>"}
→ 200 audio/wav
注意：qwen3-* 是離線整段；omnivoice/voxcpm2 走 SSE（`response_format=pcm&stream_format=sse`，
delta 欄位 VoxCPM2=`data`、OmniVoice=`audio`——兩者都兼容）
```

### 2.3 DeepSeek 流式大腦
```
POST /chat/completions  {...,"stream":true}
SSE: data: {"choices":[{"delta":{"content":"<碎塊>"}}]} ... data: [DONE]
句子切分：SENT_SPLIT = [^。！？!?；;\n]+[。！？!?；;\n]+（必須標點收尾）
         + 無標點超過 max_sentence_len(80) 硬切
```

## 3. 配置契約（assistant_config.json + .env）

- `runtime`：定版參數（asr_model / tts_model / sentence_tts / max_sentence_len / keep_tags）——改這裡即改行為
- `audio_cpp`：`voice_ref`（參考音路徑，**須 WAV**）、`reference_text`（**`@` 開頭＝讀該文字檔**，如 `@reference/voicetext.txt`；或直接填字串）、`server_url`
- `audio`：設備索引、VAD 參數（`max_record_seconds` 預設 60）
- `llm.api_key`：**留空**；金鑰放 `.env` 的 `DEEPSEEK_API_KEY`（`_load_env()` 載入，.env 優先）
- `cloud_tts`：雲端 TTS 框架殼（`enabled:false`、key 清空）——**不使用，勿填 key**

## 4. 擴展點

| 想加什麼 | 改哪 |
|---|---|
| 新的 ASR 模型 | `runtime.asr_model` 填 server.json 註冊的 id（live 端點要 streaming 模型） |
| 新的 TTS 模型 | `runtime.tts_model`；離線模型加進 `OFFLINE_TTS_MODELS`，或走 SSE |
| 新的雲端 TTS | 加一個 `xxx_tts()` 返回 `(pcm, rate)`，在 `cloud_tts()` 分發 |
| 調整句子切分 | `SENT_SPLIT` 正則 + `max_sentence_len` |
| 短句合併（消除極短句微卡） | 在 `synth_worker` 中：音頻估時 <1s 的句子併入下一個再合成 |
| 把語音記錄寫入會話 | `sentence_turn` 的 `full` 已是完整回覆，可回傳給上層 |

## 5. 測試

```bat
run_stream.bat --file 某.wav     REM 檔案模式：不進麥克風，跑完整 ASR→大腦→TTS 鏈路
```
- 沙箱/無聲卡環境：Player 會降級為「僅顯示文字」並警告，不卡死
- 顯存檢查：`nvidia-smi`（本包 ~2.5GB；多開 server 記得 unload）

## 6. 已知限制（開發注意）

1. **參考音必須 WAV**（audio.cpp 克隆不認 mp3）——雲端才用 mp3
2. **參考轉錄必須與音檔逐字一致**（VoxCPM2/克隆 ICL 模式尤其敏感；SenseVoice 可自動轉寫）
3. audio.cpp 非 ASCII **路徑**會崩（`voice_ref`/`--audio`）；文字沒問題
4. live 會話異常中斷會卡住 server → 重啟 8081
5. `sys.stdout.reconfigure(utf-8)` + bat `chcp 65001`：簡繁混排不崩
6. 播放器 8s 上限已移除；等播完、設備卡死 5s 才放棄
