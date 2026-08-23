# dsh-voice 永久外掛移植計畫

> 狀態:**草案 v1**(待審核後動工)
> 前提:動態插件 voice-1/pkg-10 已完整驗收(`Development` @ dynamic-baseline-v1.0 + bridge 修復);
> 本計畫只做「包裝與接線」,不改變任何已驗證行為。
> 流程:本文件與實作都落在 `release`;通過最終驗證後經 PR 進 `main`。

## 1. 目標與非目標

**目標**:把已驗收的動態插件變成隨 DSH 啟動自動掛載的永久雙面 npm 包。

**非目標**(明確不做):
- 不重構播放管線/狀態機/bridge 通訊協定(全部原樣移植)
- 不加新功能(串流、多輪、新模型支援等一律之後再說)
- 不動 audiocpp server 本身

## 2. 範本與安裝機制(沿用 PLAN.md 已研究成果)

範本:`@linxin666/dsh-ssh`(安裝於 `profiles/web/node_modules/@linxin666/dsh-ssh`)。

```
dsh-voice/
├── package.json        # exports: "."(host→lib/index.js) + "./client"(browser→lib/client.js)
│                       #   "dsh": { bundle: { patch: "./cordis.patch.yml" },
│                       #            client: { platform: "web", ... 同 dsh-ssh 慣例 } }
├── cordis.patch.yml    # - insert: - id: voice / name: 'dsh-voice'(一行,雙面)
├── tsconfig.json       # tsc → lib 型別;ESM
├── src/
│   ├── index.ts        # Host 半(移植自 pkg-9.host.js)
│   ├── client.ts       # Client 半(移植自 pkg-9.client.js)
│   └── config.ts       # Config schema(zod/手寫 validator,依倉庫慣例)
├── assets/
│   └── voice_bridge.py # 依賴隨包走(來源:runtime/voice_bridge.py v8+修復)
├── lib/                # 建置產出(tsc + tsdown),gitignore
└── client.js           # 瀏覽端預建置 bundle(tsdown 產出)

安裝:`dsh plugin --profile web add <本地路徑或發布名>` → 重啟 profile 生效。
```

## 3. 三個技術置換點(唯一需要「改寫」的地方)

| 動態沙箱用法 | 永久包正確做法 | 影響面 |
|---|---|---|
| `harness.handle(method)` / `host.call(method)` | dsh 標準 client↔host 通道(照 dsh-ssh 的 client-runtime 慣例;動工時先讀該包 lib 原始碼確認確切 API) | 8 個 RPC method 名稱與 payload **完全不變** |
| `harness.defineTool` + `harness.registerTool` | 靜態插件的 tool 定義 API(以 dsh-ssh 或任一 `@deepseek-ai/dsh-tool-*` 為準) | `voice_selftest` 一支 |
| 全域無 `setTimeout` → `ctx.timer` | 正式環境直接用注入服務/原生 timer(依宿主規範) | watchdog、輪詢 |

其餘(ctx.on 事件、slots 注入、ctx.effect 生命週期、subprocess/fs 注入)**語意相同,直接移植**。

## 4. Config Schema 草案

原則(DSH 倉庫規範):部署相關路徑與可調參數一律 Config 欄位,代碼零寫死。
Config 只放「部署環境+預設值」;**會被 UI 即時修改的東西走 Settings namespace**(見 §5)。

```yaml
# cordis.patch.yml 中該列的 config(全部有預設值,零配置可啟動):
config:
  audioCppExe:      'D:/Apps/audiocpp/bin/audiocpp_server.exe'
  audioCppCfg:      'D:/Apps/audiocpp/server.json'
  audioCppBinDir:   'D:/Apps/audiocpp/bin'
  apiServerLog:     'D:/Apps/audiocpp/output/api_server.log'
  apiServerErrLog:  'D:/Apps/audiocpp/output/api_server.err.log'
  serverPort:       8081
  pythonExe:        '<工作區>/LocalAudio_CLI/.assistant-venv/Scripts/python.exe'
  # bridge 路徑不由 config 給:隨包 assets/ 解析(import.meta.url 相對),避免又一個寫死路徑
  silenceSeconds:   0.8        # 收音靜音判定
  maxRecordSeconds: 30
  maxSentenceLen:   80         # 單句上限(軟切點)
  maxTtsChars:      0          # 0=不限
  voicePrefix:      '(Voice) '
  listenWatchdogMs: 90000
  thinkWatchdogMs:  240000
  speakWatchdogMs:  900000
  healthIntervalMs: 5000
  # ttsFamilies/asrIds 屬協議常識清單,維持代碼內常數(非部署差異)
```

## 5. 使用者設定遷移(Settings namespace)

UI 可變更的:`ttsModel/asrModel/presets[]/activePresetId`。
- 存取:dsh Settings capability,key `"dsh-voice"`(host 半讀寫;RPC 回傳給 client 的形狀不變)。
- **首次啟動遷移**:偵測舊 `runtime/voice-settings.json` → 匯入 → 將原檔改名 `.imported` 備份(不自動刪)。
- 克隆 wav/txt 檔案本身仍在使用者磁碟,preset 存絕對路徑(現狀不變)。

## 6. 實施階段(每段可獨立驗證、獨立 commit)

| 階段 | 內容 | 驗證 |
|---|---|---|
| P1 腳手架 | package骨架+patch.yml+建置鏈打通(host 先註冊一個 hello RPC) | `dsh plugin add` → 重啟 → GUI 看得到 |
| P2 Host 移植 | index.ts 完整移植(§3 三個置換點)+Config 接線 | selftest RPC 通、bridge 起、health 綠 |
| P3 Client 移植 | client.ts(圓鈕/設定頁/toast)+樣式 | 圓鈕三態、設定頁三卡片 |
| P4 Bridge 隨包 | assets/voice_bridge.py + 相對解析 + PID 檔清理(PLAN.md 遺留項) | 卸載服務不留孤兒程序 |
| P5 設定遷移 | Settings namespace + 舊檔匯入 | 舊 preset/模型選擇無痛帶入 |
| P6 平行驗證 | §15 快查全過(見 §7);期間動態 voice-1 保留當 fallback | 清單全 ✅ |
| P7 切換 | PR release→main、tag `permanent-v1.0`;停用並 undefine 動態 voice-1 | DSH 重啟後語音仍可用 |

## 7. §15 快查(permanent 版驗收用)

圓鈕三態 / 設定頁三卡片 / ASR 注入 / turn 關聯 / 克隆音色 / 嚴格順序 /
斷句 / 中斷即停 / TTFT 熱啟 ≤15s / 長文全文 / 服務卸載↔重啟 / toast 錯誤 /
顯存峰值 ≤5GB / voice_selftest / 設定持久化(重啟後仍在)。
另加永久版專屬兩條:**DSH 程序重啟後插件自動在**;**舊設定自動匯入**。

## 8. 風險與備忘

- **client↔host 標準通道的确切 API 未證**:P1 第一件事就是讀 dsh-ssh lib 原始碼確認;若通道形狀差異大,P2 工期上修。
- TypeScript 化:動態版是無型別 JS;移植採「先能跑再加型別」,嚴禁順手重構邏輯。
- bridge 的 ASCII 副本目錄修復(§3.9 教訓)已含在 v8,移植時原樣保留。
- `CLI` 分支與本計畫無關,不動。
