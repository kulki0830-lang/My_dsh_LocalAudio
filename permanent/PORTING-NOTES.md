# 永久化移植:踩坑記錄與實戰經驗(dsh-voice)

> 對象:把已驗證的動態 Cordis 插件(`plugin/voice-1`)移植為永久 dsh 插件(`permanent/dsh-voice`)的過程。
> 配套文件:`PORTING_PLAN.md`(計畫)、`ACCEPTANCE-P6.md`(驗收)、`dsh-voice/README.md`(套件說明)。
> 動態時代的通用教訓見 `docs/Plugin 開發經驗與踩坑紀錄.md`,本文不重複。

---

## 一、動態 vs 永久:架構差異速查

| 面向 | 動態插件(voice-1) | 永久插件(dsh-voice) |
|---|---|---|
| 宿主半 | `pkg-N.host.js` 由 cordis_define 載入 | `lib/index.js`,經 `cordis.patch.yml` insert 進 bundle |
| 客端半 | `pkg-N.client.js` 由沙箱直接 eval | `lib/client.js`,經 ModuleLoader(`window.__ModuleLoader__.load`) |
| 宿主↔客端通道 | `harness.handle(method)` JSON-RPC | HTTP 路由(`/api/dsh-voice/*`,`ctx.webServer.register`) |
| slots | 同一套 `ctx.slots.inject` | 相同,但受正式 shell 的 scope 限制(session 級 slot 要有活躍輸入框才渲染) |
| 生命週期 | 隨 session/進程消失 | 隨 profile 安裝,重啟常駐 |

**最大心法**:宿主半幾乎照抄;客端半是「換傳輸層」的重寫——所有 `host.call()` 都要翻譯成 fetch,所有樣式注入要自己管理 `<style>` 標籤。**這次全部重大事故都出在客端半或兩半的接縫上。**

## 二、部署 SOP(本機 profile)

```
安裝 = ①robocopy /MIR /XD node_modules → %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-voice\
       ②~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 陣列加入 "dsh-voice"
回滾 = 反向兩步 + 重啟
生效 = 宿主半改動需重啟 DSH;客端 lib/client.js 理論上走 HMR,但保險起見一律重啟+Ctrl+F5
```

**部署後自檢三連**(每次都跑):
```powershell
node --check lib/index.js; node --check lib/client.js          # 語法
Select-String -Path <部署副本> -Pattern '<本次改動特徵串>'        # 部署副本真的更新了
Invoke-WebRequest http://127.0.0.1:3080/api/dsh-voice/state     # 路由活著
```

## 三、踩坑記錄(症狀 → 根因 → 修法)

### ① 啟動即崩:`duplicate exact route`
- **症狀**:DSH 起不來,報 webserver exact route 重複。
- **根因**:webserver 的 exact 路由**只用 path 去重**,不管 method。我把 POST /presets 和 DELETE /presets 註冊成兩條同路徑路由。
- **修法**:一條路徑一個 handler,內部按 `req.method` 分流(`jsonRouteMulti`)。
- **教訓**:多方法資源路由永遠合併併註冊;錯誤 handler 回 405 JSON。

### ② 客端半 404 但宿主半正常
- **症狀**:`/plugins/dsh-voice/client.js` 404,ping 卻通。
- **根因**:package.json exports 只開了 `.` 和 `./client`;ClientModuleRegistry 解析 `${name}/package.json` 時拋 `ERR_PACKAGE_PATH_NOT_EXPORTED`,**靜默**把整行標記成「非客端插件」。
- **修法**:exports 加 `"./package.json": "./package.json"`。
- **教訓**:dsh-ssh 模板裡那行不是裝飾。客端載入失敗沒有任何報錯,要靠比對 bundles 清單才能發覺。

### ③ spawn ENOENT:路徑少了前導點
- **症狀**:python.exe 找不到,錯誤訊息顯示 `D:/Apps/...`。
- **根因**:從舊檔轉錄預設路徑時,`D:\.Apps\` 的 `\.` 被吃掉變成 `D:\Apps\`。共 11 處。
- **修法**:全部改回 `D:/.Apps/`(正斜杠形式在 Windows JS 裡最安全)。
- **教訓**:路徑字串逐字元核對;部署後用 `Test-Path` 驗證每個關鍵路徑。

### ④ 整份 CSS 失效(裸奔事件之一)
- **症狀**:圓鈕存在於 DOM(commButtons:1)但完全隱形,卡片無框。
- **根因**:來源檔的 CSS 是單行字串、內含字面 `\n` 兩字元;我拼接時二次轉義成 `\\n`,瀏覽器解析成「反斜線+n 文字」混進選擇器 → **CSS 解析器丟棄每一條壞選擇器的整條規則**。
- **修法**:以 `new Function('return \'...\')()` 按 JS 真正求值結果取出字串再 `JSON.stringify` 嵌入;往返驗證關鍵選擇器存在。
- **教訓**:**跨檔搬運帶跳脫的字串,永遠走「求值→重新序列化」,不做字面複製**。

### ⑤ 按鈕全啞但頁面數據正常
- **症狀**:執行/保存/刪除毫無反應;唯圓鈕和輪詢正常。
- **根因**:客端用「動作名」(`savePreset`)查以「路由名」(`presets`)為 key 的表 → `fetch(undefined)` → throw → 被 catch 默默吞掉。只有名字恰好相同的 state/config/toggle 能通。
- **修法**:補 `PATH_OF` 對照表;`act()` 的 catch 改為彈 Toast,**不再靜默吞錯**。
- **教訓**:RPC 層改名時,兩端的名字映射要有一份單一真相;catch 裡吞錯必須可見化。

### ⑥ 長文本「順序混亂」(雙 bug 疊加)
- **症狀 A(致命)**:>80 字段落一出現,該批後續句子全部消失,播放跳段。
  - 根因:`segToSentences` 用 `const` 宣告卻在迴圈重新賦值 → TypeError → 被外層 try/catch 吞掉。短文本永不觸發,故此前未現形。
  - **歸屬:移植期引入**——動態源碼用的是 `var`(可重賦值),無此問題。
- **症狀 B(體感)**:`neighbo|rs`、`biol|uminescent` 單字腰斬。
  - 根因:軟切點找不到逗號時硬切在第 N 字元(**動態版同源演算法既有缺陷**,中文標點密所以從未暴露)。
- **修法**:`let` + 軟切後備退到最後一個空白;以「切出的句子拼回原文逐詞比對一致」作為驗證標準。
- **教訓**:**吞錯的 catch 是沉默殺手**——長文本測試是必需項;驗證切分用「詞流還原一致性」而非肉眼。

### ⑦ 英文分句
- 需求:英文句點要能斷句,又不能誤傷小數/縮寫/URL。
- 正則寫法的兩個陷阱:
  1. **lookbehind 放在被匹配字元之後,檢查的是「它前面那個字元」**——放在句點後面就變成檢查句點自己,必然失配(dbg:L+B 各自都中、合起來全滅)。
  2. 巢狀縮寫 lookbehind(e\.g 含內部點)極難對齊位置 → 改成**程式碼集合過濾**(正則抓邊界、`ABBREV` Set 過濾),好測好讀。
- 最終形態:強標點 `[。！？!?；;\n]` 直切;句點僅當「前接字母數字閉合符 + 後隨空白與大寫/數字/引號」才算邊界。

### ⑧ 「重啟無效」的假象(環境類)
- **症狀**:怎麼重啟都是舊行為;新程序起來就崩。
- **根因**:8/22 啟動的老 DSH 程序一直佔著 3080 且**熱掛載磁碟變更**;用戶的「重啟」只是另開新程序(崩在別處),老兵不死。
- **修法**:淨場程式——先找出佔 3080 的 PID 徹底殺掉,再乾淨啟動。
- **教訓**:**任何「改了沒效」先驗證「跑的是哪個程序、哪份檔案」**,再懷疑自己的程式碼。

### ⑨ 樣式裸奔的診斷誤區
- 全 app 裸奔那次,實際上是老視窗/HMR 快取殘影;Console 探測(`document.querySelectorAll('style')` 的 `data-plugin` 分佈、computed style 取 `--dsw-*` 變數)證明樣式系統早已恢復。
- **教訓**:**截圖 > 文字描述;探測腳本的輸出 > 猜測**。主題 tokens 定義在 `body` 上,探測要打對元素。

## 四、診斷方法論(按成本遞增)

1. **零副作用探測**:GET state/config;錯誤 method 打路由看是否回我們的 405 JSON(證明路由存在且分流活着);空 body POST 看 validation 訊息。
2. **瀏覽器 Console 片段**:style 標籤歸屬清單、特定 class 元素計數、computed token、React props key(`__reactProps`)是否存在。
3. **模擬器**:把宿主函式**原樣抽出**(regex 抓函式體 + new Function)餵真實案例——測的是部署的程式碼,不是測試副本。
4. **有副作用的實測**:放最後,且先告知用戶。

## 五、已知限制(記錄在案,暫不處理)

| 項目 | 現象 | 原因 | 未來解法 |
|---|---|---|---|
| 串流 TTS 模型 | `HTTP 500: VoxCPM2 streaming generation requires retry_badcase=false` | audiocpp 該模型需旗標 | bridge 送 start-server 時帶模型相容旗標 |
| doctor `/status` 404 | 第三方 doctor 面板輪詢不存在的路由 | 該面板預期的路由不存在 | 無害噪音,忽略 |
| 句點後小寫不切 | `one two. three` 不斷句 | 防檔名 `file.txt` 誤傷的取捨 | 可加白名單 |
| URL 內 `?` 會切句 | 含 query string 的網址被斷 | `?` 是強標點 | 前後文判斷 |

### 回修記錄(動態源碼同步)

永久化過程發現的**同源演算法缺陷**已回修到動態版參照源碼 `plugin/voice-1/pkg-9.host.js`(2026-08-23):
1. 英文句點分句規則 + 縮寫程式碼過濾(§三⑦)
2. 軟切點空白後備,永不腰斬單字(§三⑥-B)

驗證方式與永久版相同:抽取宿主真實函式、以用戶長文本跑詞流還原比對,18 段全落詞邊界、輸出與永久版逐字一致。`Development` 分支凍結線(`dynamic-baseline-v1.0`)不動——回修只落在 `release` 分支的參照副本上。注意:`pkg-9.host.js` 是函式體檔(cordis_define 直接 eval),語法驗證要用 `new Function(body)` 而非 `node --check`。

## 六、流程經驗(與人與工具)

- **Git**:沙箱下每次 pwsh 只跑**一條** git 命令(連發會 Access denied);push 需要 `danger-full-access` 提權一次完成。
- **與用戶的節奏**:我先部署→請用戶重啟+Ctrl+F5→用戶回報症狀原文(OCR/貼錯誤串=地面真相)。每階段做完等口令再前進,不搶跑。
- **每修必 commit**,訊息寫清「症狀+根因」,讓這份文件的每一條都能對應到一個 hash。
- **驗收順序**:先核心功能(§15)→ 遷移完整性(設定/預設)→ 邊角(長文本/英文)→ 再談退役動態版。

## 七、之後怎麼繼續開發新功能

```
feature/xxx(從 release 切出)
   │  改 permanent/dsh-voice/lib/*.js
   ▼
robocopy 部署到 profile → 重啟 DSH → 實測
   ▼ 滿意後合併回 release(隨時推 GitHub 備份)
   ▼ 累積到穩定里程碑才 PR release→main + 打 tag
```

- **預設工作線是 `release`**,不是 main。main 只收里程碑快照,實驗代碼永不直進。
- **永久版部署摩擦已與動態相當**(一次 robocopy+重啟),動態沙箱不再是必經之路。
- **動態沙箱的剩餘價值=炸了不傷本體**:測可能弄崩啟動的東西(新路由、壞 import)時,丟一次性動態插件試錯;崩了重開 session 即可,`~/.dsh/profiles` 不受影響。
- 改**宿主半**(lib/index.js)必須重啟;改**客端半**(lib/client.js)理論上走 bundle HMR,但保險起見一律重啟+Ctrl+F5 再判定。

---
*最後更新:2026-08-23,對應 release 分支 `69adb4a`。*
