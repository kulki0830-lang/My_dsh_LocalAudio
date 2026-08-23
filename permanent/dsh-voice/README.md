# dsh-voice(永久外掛)

動態插件 `voice-1/pkg-10`(已完整驗收)的永久化版本。移植計畫見 [`../PORTING_PLAN.md`](../PORTING_PLAN.md)。

## 目前階段:P3 — 雙面齊備(待安裝驗證)

| 檔案 | 內容 |
|---|---|
| `lib/index.js` | 宿主半完整源碼:round 狀態機/串流分句/事件關聯/bridge 管理/服務生命週期,8 個 RPC→`/api/dsh-voice/*` 路由,路徑與參數全部 Config 化(schemastery,零配置可啟動) |
| `lib/client.js` | 客端半完整源碼:CommButton/VoiceSection/Toast 三 slot,以 `window.__ModuleLoader__.load` 註冊,React 取自平台種子表;CSS 為自有 `<style>` 元素 |
| `assets/voice_bridge.py` | 依賴隨包(v8 含 ASCII 目錄修復);路徑以 import.meta.url 相對解析 |
| `cordis.patch.yml` | 插頁:一行 `- insert: - id: voice / name: 'dsh-voice'` |

**離線驗證已過**:宿主(node --check + import + Config 預設值)、客端(node --check + CSS 完整搬運)。
**未驗證**:真實掛載(需安裝+重啟)。安裝後動態 voice-1 將隨重啟消失,永久版按鈕/設定頁直接接手。

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
