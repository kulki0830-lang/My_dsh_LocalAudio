# dsh-voice(永久外掛)

動態插件 `voice-1/pkg-10`(已完整驗收)的永久化版本。移植計畫見 [`../PORTING_PLAN.md`](../PORTING_PLAN.md)。

## 目前階段:P2 — 宿主半完整移植(未安裝)

| 檔案 | 內容 |
|---|---|
| `lib/index.js` | 宿主半完整源碼:round 狀態機/串流分句/事件關聯/bridge 管理/服務生命週期,8 個 RPC→`/api/dsh-voice/*` 路由,路徑與參數全部 Config 化(schemastery,零配置可啟動) |
| `assets/voice_bridge.py` | 依賴隨包(v8 含 ASCII 目錄修復);路徑以 import.meta.url 相對解析 |
| `cordis.patch.yml` | 插頁:一行 `- insert: - id: voice / name: 'dsh-voice'` |

**P2 刻意維持純宿主半**(package.json 無 `dsh.client`)——瀏覽器端零載入,P3 補上。
本地煙霧測試:`node --check` + file:// import(Config 預設值解析驗證);
`node_modules/` 是測試鏡像已 gitignore,實際運行由 profile 樹解析依賴。

## 安裝(P1 驗證用)

```sh
dsh plugin --profile web add <本目錄絕對路徑>
# 重啟 DSH 後生效,驗證:
curl http://127.0.0.1:3080/api/dsh-voice/ping
# 預期 {"ok":true,"plugin":"dsh-voice","stage":"P1",...}
```

## 回滾

```sh
dsh plugin --profile web remove dsh-voice
# 重啟 DSH 即完全回到安裝前狀態
```

## 與動態插件的關係

並行不衝突:動態 voice-1 由會話內手術式掛載,本包由 profile 啟動清單掛載;
兩者都只在被點擊時才碰 8081/麥克風。P7 全數驗收通過後才停用動態版。
