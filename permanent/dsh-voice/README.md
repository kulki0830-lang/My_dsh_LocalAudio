# dsh-voice(永久外掛)

動態插件 `voice-1/pkg-10`(已完整驗收)的永久化版本。移植計畫見 [`../PORTING_PLAN.md`](../PORTING_PLAN.md)。

## 目前階段:P1 — 掛載腳手架

**範圍**:純宿主半。只證明兩件事——bundle patch 能掛上、`/api/dsh-voice/*` 路由通道可用。
不含任何語音邏輯;`package.json` 刻意**沒有** `dsh.client`,瀏覽器端零載入。

| 檔案 | 內容 |
|---|---|
| `lib/index.js` | 宿主半源碼(P1 為零建置直跑 ESM;P2 引入 TS 建置鏈後改為產物) |
| `cordis.patch.yml` | 插頁:一行 `- insert: - id: voice / name: 'dsh-voice'` |

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
