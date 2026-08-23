# voice-1 版本軌跡（pkg-1 … pkg-9）

> 動態插件的每個 Package 是不可變版本；本檔記錄沿革。
> **僅 pkg-9（已驗收之 current）保留完整源碼**於本目錄；歷史版本不逐包備源。

| Package | 主題 | 要點 | 結局 |
|---|---|---|---|
| pkg-1 | 初版 | Client 圓鈕+設定頁骨架;Host 直呼 curl 探測 8081 | 被 pkg-2 取代 |
| pkg-2 | bridge 誕生 | 全部 HTTP/程序管理移入 python bridge(繞開宿主 spawn curl 0xc0000142);toast 呈現所有拒絕;新增 voice_selftest Tool | defineTool 欄位錯(host-half-failed) |
| pkg-4 | DSL 修正 | `parameters` 取代 `inputSchema`(defineTool 契約) | output.schema 缺 additionalProperties |
| pkg-5 | schema 修正 | `additionalProperties:true` 顯式宣告 | ✅ 可跑,但功能缺陷待修 |
| pkg-6 | 鍵名正規化 | camelCase→snake_case alias 修復克隆 TTS 500 與啟動空路徑 WinError 3;點色 CSS hex fallback;TTS 錯誤帶回應內文 | ✅ 使用者確認克隆可用 |
| pkg-7 | 順序與預熱 | 播放 seq 順序鎖修亂序;失敗哨兵跳句;收音期預熱模型;切分器升級(Markdown 清洗/軟切點/雜訊過濾) | ✅ 順序確認;TTFT 仍 20–60s |
| pkg-8 | 真串流管線 | 改聽 `assistant/chunk` text-delta 邊生成邊逐句派發(不等 turn/end);靜音判定 0.8s;移除播報前阻塞往返 | ✅ TTFT 最短 ~3s |
| **pkg-9** | **上限解除** | **maxTtsChars 0=不限(原 500 造成長文 503 字斷音);播放看門狗 5→15 分** | ✅ 驗收通過=dynamic-baseline-v1.0 |
| **pkg-10** | **bridge 重載(現行)** | **Host/Client 不變;重載 bridge 套用修復:ASCII 副本目錄改至純 ASCII 路徑(audiocpp/output 或系統暫存)**——參考檔搬入中文工作區後克隆 TTS 全 500 的根因 | ✅ 使用者實測恢復正常 |

## 重建 current

**current = pkg-10;其 Host/Client 源碼與 pkg-9 完全相同**——pkg-10 僅為「套用 bridge 修復後重載橋接程序」而定義(bridge 由插件 spawn,改了 `voice_bridge.py` 必須追加新 Package 重跑插件才會生效),代碼零變更。
因此本目錄的 `pkg-9.host.js` + `pkg-9.client.js` 即現行完整源碼(函式主體形式)。

重新部署:`cordis_define(kind:'existing', pluginId:'voice-1', code:{host:<host 檔全文>, client:<client 檔全文>})` → `cordis_run(mode:'update' 或 'run')`,首次需 GUI 核准。

> **規則**：只有 Host/Client 代碼變更才需要新的 js 檔；bridge 變更只需追加同源碼的新 Package 觸發重載。

## 歷史教訓索引

各版本的錯誤嘗試與根因詳見 [`../../docs/Plugin 開發經驗與踩坑紀錄.md`](../../docs/Plugin%20開發經驗與踩坑紀錄.md) §3/§4;
驗證結果見 [`../../docs/即時語音-動態插件驗收紀錄.md`](../../docs/即時語音-動態插件驗收紀錄.md)。
