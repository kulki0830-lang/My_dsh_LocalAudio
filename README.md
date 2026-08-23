# My_dsh_LocalAudio — 即時語音動態插件開發基線

> **本分支（`Development`）是 Dynamic Plugin Development Branch**：
> 保存已驗收成功的 DSH 動態 Cordis Plugin「voice-1（即時語音整合）」，作為未來動態插件持續開發的基準線。
> 對應標籤：`dynamic-baseline-v1.0`。

## 這是什麼插件

在 DeepSeek Harness Web GUI 內提供**即時語音互動**：

- 對話輸入區右側出現**通訊圓鈕**（麥克風／藍點＝收音中／橘點＝思考或播報中）
- 點擊後麥克風收音 → ASR 轉文字 → 注入當前對話 → 模型回覆**邊生成邊逐句 TTS 朗讀**
- 設定頁三卡片：服務控制（8081 啟停）、模型配置（TTS/ASR 切換）、克隆音色（參考 wav+文本預設 CRUD）

## 已驗證功能（實測）

| 能力 | 實測結果 |
|---|---|
| ASR 辨識注入對話（`(Voice) ` 前綴） | ✅ |
| 串流回覆逐句朗讀，順序嚴格正確 | ✅ 659 字長文全文播畢 |
| TTFT（說完到首聲） | ✅ 冷啟 ~12s／熱啟 ~4s（LLM 首字起算最短 ~3s） |
| 克隆音色（qwen3 家族 voice_ref+reference_text） | ✅ |
| 播放中斷、服務卸載↔重啟、錯誤 toast | ✅ |
| 顯存 | ✅ 峰值 5GB／駐留 ~3.8GB（8GB 卡） |

完整清單見 [`docs/即時語音-動態插件驗收紀錄.md`](docs/即時語音-動態插件驗收紀錄.md)。

## 專案結構

```
My_dsh_LocalAudio/
├── README.md                    ← 本檔
├── docs/                        Documentation
│   ├── 即時語音-動態插件驗收紀錄.md      （驗收結果+架構圖+版本沿革）
│   └── Plugin 開發經驗與踩坑紀錄.md      （可複用經驗/錯誤嘗試/除錯方法論）
├── plugin/voice-1/              Dynamic Plugin
│   ├── pkg-9.host.js            （Host 半源碼;現行 pkg-10 內容相同,見 PACKAGES.md）
│   ├── pkg-9.client.js          （Client 半源碼;現行 pkg-10 內容相同）
│   └── PACKAGES.md              （pkg-1..10 版本軌跡與重建規則）
├── runtime/                     Runtime / Bridge
│   ├── voice_bridge.py          （常駐橋接：8081 管理/ASR 收音/有序播放/--selftest）
│   └── voice-settings.example.json（設定範本；實際檔屬個人本機狀態，不入庫）
└── development/                 Development information
    └── ENVIRONMENT.md           （外部依賴、啟動方式、重建步驟、限制）
```

## 如何啟動 / 執行

前置依賴與逐步操作見 [`development/ENVIRONMENT.md`](development/ENVIRONMENT.md)。摘要：

1. 就位外部依賴：audiocpp server（含模型）、venv python（numpy/sounddevice/requests）、路徑與 `plugin/voice-1/pkg-9.host.js` 頂部常數對齊。
2. 在 DSH 中以該 host/client 源碼 `cordis_define`（existing → voice-1）並核准 run（current=pkg-10,源碼同 pkg-9）。
3. 設定頁按「執行」啟動 8081；點通訊圓鈕開始語音對話。
4. 診斷：呼叫 `voice_selftest` Tool，或 `python voice_bridge.py --selftest`。

## 本版本的開發方式

- **動態插件**：修改 = 在同一 pluginId 追加新不可變 Package（cordis_define）→ 核准 → update；失敗看 host-half diagnostics 修同一插件。流程與契約細節見 `docs/Plugin 開發經驗與踩坑紀錄.md` §1–§3。
- **Bridge**：改 `runtime/voice_bridge.py` 後以 `--selftest` 離線驗證，再重跑插件（bridge 由插件 spawn，無需其他註冊）。
- 新分支一律自 `Development` 分出；文件同步更新。

## 目前限制（如實聲明）

- 僅 Windows 驗證（路徑、taskkill、DETACHED_PROCESS 特化）；非 ASCII 音檔路徑需 ASCII 副本機制。
- 冷啟首輪 TTFT ~12s（模型懶載入，無 load 端點，靠收音期預熱掩蓋）。
- 剩餘延遲底線＝LLM API 首句速度＋合成時間；單輪狀態機一次僅一輪語音。
- 其他 TTS 模型（voxcpm2/omnivoice 等）管線同構但未逐一實聽；英文/混雜語言品質未系統性測試。
- 動態插件生命週期限當前 DSH 程序，程序重啟需重新 define+run。
- 未驗證項目全表見驗收紀錄 §「尚未驗證」。

## Permanent Plugin 不在本分支

本分支**不含** cordis.yml 永久化、host composition 接線或任何永久移植工作。
Permanent 移植是獨立的下一階段，完成後應另立分支/標籤，不得混入本基線。

## 未來開發的基準

> 新的 Dynamic Plugin 開發一律以本 branch（`Development`, tag `dynamic-baseline-v1.0`）為起點：
> 沿用三層架構（Client Slot UI → Host 狀態機/RPC → bridge JSON Lines 子程序）、
> selftest-first 除錯模式與既有的踩坑教訓；保持「先驗證、再入庫」的紀律。
