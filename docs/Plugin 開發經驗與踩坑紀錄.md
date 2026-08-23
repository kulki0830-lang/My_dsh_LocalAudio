# Plugin 開發經驗與踩坑紀錄

> **本文件目的：**
> 將本次 Plugin 實際開發、除錯、驗收過程中的可複用經驗、錯誤嘗試與重要注意事項整理出來。
> **本文件不是開發紀錄，也不是下一階段 PLAN。**
> 重點是「下一位 Plugin 開發者可以從這次經驗學到什麼」。
>
> 對象：DeepSeek Harness（DSH）上的動態 Cordis Plugin 開發，含 Host 程序、瀏覽器 Client、外部子程序（bridge）三層。
> 佐證來源：插件 `voice-1`（pkg-1…pkg-9）、`dsh_LocalAudio/runtime/voice_bridge.py`、`02-docs/即時語音-動態插件驗收紀錄.md`。

---

## 1. Plugin 開發前必讀

> 在開始新的 Plugin 開發前，應先閱讀本節。
> 只記錄已經被本次實作驗證過、且具有實際參考價值的事項。

### 1.1 必須知道的架構
1. **一切能力都是 Plugin**：Host 註冊 Service/Event/Tool/RPC handler；Client 只能透過 Slot 註冊 UI。Client 不能直接碰 DOM 或業務 Service。
2. **雙平台分工**：Host 跑在 DSH Node 程序內（檔案、子程序、事件、Tool）；Client 跑在瀏覽器頁面（主題、版位 UI）。兩半各自是一個 Package 的兩份原始碼，**通訊只有一條路：Client `host.call(method,args)` → Host `harness.handle(method,handler)`**，且只走無損 JSON。Host 不能反推 UI。
3. **Package 不可變**：每次改碼都是 `cordis_define` 在同一個 `pluginId` 下**追加**新 Package（pkg-N），用 `cordis_run mode:'update'` 切換；舊版本保留可回滾。`currentPackageId` 只在完整成功後才移動。
4. **Inspect Provider 是查契約的工具，不是業務 API**：動態碼裡只能呼叫真實 Service/Event；Inspect 查到的 schema 用於「寫碼前確認簽名」。本次經驗：**當 Inspect 精確查詢壞掉時（見 §3.1），直接讀 DSH 倉庫原始碼（`packages/core` 等）是可靠的事實來源**。

### 1.2 必須注意的生命週期
1. **動態 Plugin 只活在當前 DSH 程序**：程序重啟即消失（定義、grant、執行狀態全部不留）。重啟後要重新定義+run。
2. **每個新 Package 都要過核准**：首次 run 會進 `awaiting-approval`，使用者在 UI 按 ✓ 才會啟動；單勾只授權當前 Package，雙勾授權同 Plugin 未來版本。
3. **update 先停舊再起新**：失敗不自動回滾——`currentPackageId` 留在舊版、`nextPackageId` 指向失敗的新版；修好後再次 update，或對舊 packageId 用 `run` 回滾。
4. **所有副作用必須掛 Fiber**：Service、Event 監聽、Tool、RPC handler、interval、Slot、樣式，一律透過 `ctx.effect()/ctx.on()` 取得 disposer；否則 stop/update 後殘留。
5. **Plugin stop 會觸發清理 effect**：本次利用這點在 cleanup effect 中 terminate bridge 子程序，確保不留孤兒程序。

### 1.3 不要直接假設的事情
1. **不要假設沙箱裡有常規全域**：Host 無 `fetch`/`process`/`setTimeout`；Client 無 `useRef`、無全域 `setTimeout`。計時器一律用注入的 `timer` 服務（`ctx.timer.timeout/interval`）。
2. **不要假設主題 token 一定存在**：`--dsw-alias-brand-primary` 在某些主題未定義 → 元素透明被看成灰色。CSS 變數一律帶 hex fallback（`var(--token, #hex)`）。
3. **不要假設外部 exe 在宿主子程序環境能跑**：曾有 `curl.exe` 在 DSH 宿主的子程序中 DLL 初始化崩潰（0xc0000142）的實例。熱路徑應避免依賴任何系統 exe。
4. **不要假設設定檔只有你在寫**：UI 操作會隨時持久化設定；agent 改檔前若先前讀過，會撞「file changed since read」，必須重讀再改。
5. **不要假設文件/規劃稿的常數永遠正確**：`maxTtsChars: 500` 這類護欄預設值，在需求演變後會變成 bug（長文在第 503 字斷音）。

### 1.4 已確認的正確做法
1. **先讀源碼再寫碼**：Service 方法、Event payload（如 `assistant/chunk` 的 `StreamChunk`）、Slot 註冊契約、guard 的 schema 規範，全部以 `packages/**/src` 為準。
2. **宿主內自我檢測 Tool**：註冊一支 `*_selftest` Tool（spawn 探測、bridge 存活、服務狀態），agent 可隨時實測運行環境，省去反覆猜測。
3. **bridge 常駐 + JSON Lines**：把所有 HTTP/程序管理收進一個常駐 python 子程序，stdin/stdout 以行式 JSON 通訊；宿主端 200ms 輪讀 stdout offset 解析事件。
4. **鍵名在邊界正規化**：跨語言設定傳遞時，接收端明確做 camelCase↔snake_case alias 表，拒絕靜默丟欄位。

---

## 2. 本次實作驗證了什麼

> 只記錄實際測試成功的能力。
> 不要把推測中的能力寫成已驗證。

### 2.1 已驗證流程

| 流程階段 | 驗證結果 | 說明 |
| :--- | :---: | :--- |
| ASR 語音辨識 | ✅ | sounddevice 收音+靜音偵測(0.8s)，multipart 送 `/v1/audio/transcriptions` |
| 取得文字 | ✅ | bridge `asr-final` 事件攜帶轉寫文本 |
| 送入當前 Conversation | ✅ | `agents.get(sessionId).followup(UserMessage)` 注入，`(Voice) ` 前綴 |
| 取得模型回應 | ✅ | `agent/inbox/claimed` 綁 turn；`session/event` 消費串流 |
| TTS 語音合成 | ✅ | 內建 speaker 與克隆音色(`voice_ref`+`reference_text`)皆可 |
| 有序播放 | ✅ | seq 順序鎖下 659 字長文全程按序播畢 |

### 2.2 已驗證的元件

| 元件 | 驗證結果 | 說明 |
| :--- | :---: | :--- |
| voice_bridge | ✅ | JSON Lines 雙向；8081 啟停(taskkill 樹刪/Popen detached)、模型管理、健康探測 |
| ASR | ✅ | sense-asr；模型懶載入由預熱掩蓋 |
| Conversation Integration | ✅ | followup 注入+turn 關聯+串流 chunk 消費，多步工具回合也正常 |
| TTS | ✅ | qwen3 家族(含 bf16)；分句邊生成邊合成 |
| 動態 Plugin | ✅ | 九次 define/run/update 迭代、核准流程、失敗診斷修復全走通 |
| restart / run | ✅ | 使用者手動 stop→run(pkg-9) 成功；update 失敗後同 Plugin 追加修正版重跑成功 |
| 自我檢測 Tool | ✅ | `voice_selftest` 於宿主內 spawn curl/python 實測並回報 bridge/服務狀態 |
| 設定持久化 | ✅ | voice-settings.json；UI 切模型即時落盤 |

### 2.3 尚未驗證

> 明確列出本次沒有驗證的能力，避免下一位開發者誤以為已完成。

| 項目 / 能力 | 驗證狀態 | 說明 / 未驗證原因 |
| :--- | :---: | :--- |
| DSH 程序重啟後自動恢復 | ⏳ 未驗證 | 動態 Plugin 定義不跨程序存活，理論上需重新 define+run |
| 8081 中途崩潰的輪內恢復 | ⏳ 未驗證 | 健康探測會翻紅，但「播放中伺服器死掉」的恢復體驗未刻意測試 |
| 其他 TTS 模型(voxcpm2/omnivoice/voicedesign) | ⏳ 未驗證 | 清單有列、切換管線同構，但未逐一實聽 |
| 英文/混雜語言朗讀品質 | ⏳ 未驗證 | 測試以中文為主；切分器的軟切點含半形逗號但雜訊規則偏 CJK |
| 多輪並發/多會話同時語音 | ⏳ 未驗證 | 單 round 狀態機設計為一次一輪(busy 拒絕) |
| 長時間駐留記憶體表現 | ⏳ 未驗證 | 數小時級洩漏觀察未做 |
| macOS/Linux 環境 | ⏳ 未驗證 | 路徑、taskkill、DETACHED_PROCESS 皆 Windows 特化 |
| `pnpm run dev:web` 未啟動時的 client 熱更新 | ⏳ 未驗證 | 本次 client 更新都伴隨整包 activation |

---

## 3. 錯誤嘗試經驗

> **本節是本文件最重要的部分之一。**
> 記錄「看起來合理，但實際上不行」的做法，以及為什麼不行。

### 3.1 依賴 Inspect 精確查詢取得 API 契約

* **原本想做什麼：** 寫碼前用 `cordis_inspect_query` 精確查詢 Service/Event/Slot 的結構化契約。
* **採用的方法：** 依 Provider manifest 帶 `input` 物件查詢。
* **實際結果：** 任何 `input` 一律被拒：`"input" must be an object`(JSON/YAML 各種形態都試過)。
* **問題原因：** 該通道在此建置中的輸入解析異常(工具層 bug，非用法錯誤)。
* **最後採用的方式：** 直接讀 DSH 倉庫源碼:`packages/core/session/src/types.ts`(SessionEventMap/StreamChunk)、`packages/extensions/cordis-host-runner/src/guard.ts`(defineTool schema 規範)、`packages/client/ui-conversation`(Slot 契約)、`packages/subprocess`(SpawnSpec)。

> **給下一位開發者的建議：**
> 不要再嘗試在壞掉的通道上耗時間；**倉庫源碼是第一事實來源**。目錄型(無 input)查詢仍可用於發現清單。

### 3.2 Client 使用 React.useRef 與全域 setTimeout

* **原本想做什麼：** Client 端保存輪詢計時器與可變狀態。
* **採用的方法：** `React.useRef(...)`、`setTimeout(...)`。
* **實際結果：** 定義階段就被擋(Client 沙箱僅暴露 React.createElement/useState/useEffect 與注入服務)；若不是 define 前自查攔下，會在瀏覽器端運行時爆 ReferenceError。
* **問題原因：** Client builtin 白名單極小，未文件化的全域一概不存在。
* **最後採用的方式：** 可變共享狀態放模組層 store 物件 + `useState(0)[1]` 強制刷新訂閱；計時用 `ctx.timer.timeout/interval`(inject `['timer']`)。

> **給下一位開發者的建議：**
> Client 端把「能用什麼」想成白名單而非黑名單；先查 `packages/extensions/cordis-client-runner` 的 builtin 表再動筆。

### 3.3 harness.defineTool 用 inputSchema 欄位

* **原本想做什麼：** 註冊診斷 Tool 並宣告無參數。
* **採用的方法：** `defineTool({name, description, inputSchema: {...}, output, execute})`。
* **實際結果：** run 後 host-half-failed:`parameters must be a ParameterSchemaSpec object`。
* **問題原因：** 動態 Tool 的 schema 欄位叫 **`parameters`**(統一 DSL)，不是 OpenAI 風格的 `inputSchema`；且空物件 `{}` 即為「開放屬性表」。
* **最後採用的方式：** `parameters: {}`。

> **給下一位開發者的建議：**
> 不要再嘗試 inputSchema;欄位名以 `guard.ts:sandboxDefineTool` 為準。另注意 `output.schema` 內 **`additionalProperties` 必須顯式 true/false**,省略會在下一次 run 直接炸(`unsupported JSON schema`)。

### 3.4 宿主熱路徑依賴外部 exe(curl/netstat/taskkill/powershell)

* **原本想做什麼：** 插件 Host 直接 spawn curl 探測 8081、netstat/taskkill/powershell 管理伺服器。
* **採用的方法：** `subprocess.spawn([CURL,...])` 等一次性呼叫。
* **實際結果：** 使用者端出現 curl 圖形化錯誤 `應用程式無法正確啟動(0xc0000142)` 且按鈕完全沒反應(liveness 恆 false → 拒絕無提示)。
* **問題原因：** 由插件宿主派生的子程序在該環境下 DLL 初始化失敗(同一台機器 pwsh 手跑正常)；此外「拒絕無提示」讓故障不可觀測。
* **最後採用的方式：** 全部外呼移進常駐 python bridge(socket 探活、Popen+taskkill 樹刪)；client 加 toast 讓所有拒絕可見。(後續 selftest 證實 curl 又能跑了——更說明此類環境性故障不可依賴。)

> **給下一位開發者的建議：**
> 熱路徑零外部 exe；需要系統操作就交給一個你 fully controlled 的直譯器子程序(python/node)。**任何使用者動作失敗都必須有 UI 回饋**，否則等於沒處理。

### 3.5 跨語言設定直接逐鍵覆蓋(camelCase vs snake_case)

* **原本想做什麼：** Host 把設定(含 server 路徑、克隆音色)傳給 bridge 生效。
* **採用的方法：** bridge `apply_config` 以 `k in CFG` 過濾後 update；Host 送 camelCase(`voicePath`/`cfgPath`…)，CFG 鍵是 snake_case。
* **實際結果：** 兩個看似無關的故障同時出現——克隆 TTS 500(音色參數被丟)、8081 啟動 `[WinError 3] 路徑 ''`(`cfg_path` 空)。症狀完全不同、根因同一個。
* **問題原因：** 靜默丟棄未知鍵 + 兩端命名慣例不一致。
* **最後採用的方式：** bridge 端 alias 表(`SERVER_KEY_ALIAS`/`TTS_KEY_ALIAS`)正規化後再合併。

> **給下一位開發者的建議：**
> 跨邊界的資料合約要嘛統一命名、要嘛顯式映射；**「過濾掉不認得的鍵」必須至少記 log 或在 config-ok 回顯生效值**，讓丟失可見。

### 3.6 多句並發合成直接搶共用播放佇列

* **原本想做什麼：** 每句一條合成執行緒，完成即入隊播放(流水線)。
* **採用的方法：** 全域 `deque` + 各執行緒 `extend(q, chunks)`。
* **實際結果：** 句序亂跳(第 1 句快過第 0 句就先播出)。
* **問題原因：** 「完成順序」≠「句子順序」，佇列沒有索引概念。
* **最後採用的方式：** `ready[seq]` 緩衝 + `next_seq` 嚴格推進；失敗句放 `None` 哨兵照樣推進(不卡死)；drain 條件加 `ready 清空`。

> **給下一位開發者的建議：**
> 流水線必配順序鎖；失敗路徑要想清楚「跳過」還是「等待」，等待就是死鎖。

### 3.7 等整個 LLM 回合結束才開始 TTS

* **原本想做什麼：** 收齊完整回覆→切句→合成(簡單可靠)。
* **採用的方法：** 監聽 `turn/end` 才 dispatch。
* **實際結果：** TTFT 20–60 秒；大頭全是 DeepSeek API 生成時間，TTS 只是最後 3–7 秒卻排在最後。
* **問題原因：** 事件粒度誤用——存在 `assistant/chunk`(text-delta)串流事件卻沒用它。
* **最後採用的方式：** 文字流累積+指標掃描，湊滿硬切點立即清洗/切分/派發(seq 遞增)；turn/end 只負責收尾剩餘段。

> **給下一位開發者的建議：**
> 做「回應式」功能前先翻 `SessionEventMap` 全表找串流事件；延遲優化的第一步是量測各階段占比，而不是調 TTS 本身。

### 3.8 在 pwsh 沙箱裡用管道驅動子程式測試 bridge

* **原本想做什麼：** 寫一支 python driver 以 stdin/stdout pipe 與 bridge 對話做整合測試。
* **採用的方法：** `subprocess.Popen(..., stdin=PIPE, stdout=PIPE)`。
* **實際結果：** `PermissionError [WinError 5]` 於 `CreatePipe`——沙箱明文禁止程式間管道捕獲(文件化邊界，非 bug)。
* **問題原因：** 受限模式禁止 named pipe 建立。
* **最後採用的方式：** 在 bridge 內建 `--selftest` 模式(config→port→models→speak→drain 全鏈自查)，pwsh 直跑無管道。

> **給下一位開發者的建議：**
> 沙箱限制出現時先判斷是否「文件化邊界」——是的話改架構(把測試模式內建到被測物)，不要繞路或反覆重試。

### 3.9 「ASCII 副本」目錄本身落在非 ASCII 路徑下

* **原本想做什麼：** audio.cpp 對含非 ASCII 字元的 `voice_ref` **路徑**回 HTTP 500「No mapping for the Unicode character exists in the target multi-byte code page」(Win32 ERROR_NO_UNICODE_TRANSLATION),故 bridge 把 wav 複製到副本目錄再送出。
* **採用的方法：** 副本固定放在 `BASE/ascii-refs`(`BASE`=bridge 所在工作區目錄)。
* **實際結果：** 參考音檔原放在純 ASCII 的 `D:/.Apps/audiocpp/...` 時一切正常(路徑本來就 ASCII,根本不走副本)；使用者把參考檔搬進**中文工作區**後，每個克隆 TTS 請求必 500——副本的上層目錄全是中文，「ASCII 副本」名不符實。
* **問題原因：** 防禦機制只檢查了「來源路徑是否需要複製」，沒有保證「副本目的地的完整路徑」是 ASCII;且錯誤訊息指向碼頁轉換，誘導先去懷疑文字內容(emoji/簡體字)，繞了遠路。
* **最後採用的方式：** `_ensure_ascii_dir()` 惰性選定副本目錄——優先 `<server exe 根>/output/ascii-refs`(audiocpp 樹為純 ASCII),退回系統暫存目錄；候選整條路徑必須 ASCII 才採用。實測中文來源 → ASCII 副本 → 200。

> **給下一位開發者的建議：**
> 「轉換/淨化」類防禦必須對**輸出的完整路徑**做斷言，而不是只處理輸入；搬移被引用的資料檔是防禦失效的常見觸發點。除錯時先用二分法隔離欄位(path vs input vs reference_text 各自替換成安全值)，不要被錯誤訊息的字面意思帶著走——本次文字內容(含 Big5 缺字的簡體字)實證無害，唯一觸發點是路徑。

---

## 4. 除錯經驗

> 記錄實際遇到的問題，以及有效的排查方式。
> 重點不是完整複製 Debug Log，而是萃取「遇到類似問題時怎麼查」。

### 4.1 問題：克隆 TTS 回 500 且伺服器啟動報空路徑

* **現象：** 同一輪測試裡，`/v1/audio/speech` 500 Internal Server Error；另一次卸載後重啟 8081 報 `[WinError 3] 系統找不到指定的路徑：''`。
* **可能原因：** 音色檔格式？命令列參數？
* **實際原因：** 兩者皆是 Host→bridge 設定的 camelCase 鍵被 bridge 過濾丟棄(`voicePath`/`referenceText`/`cfgPath`)。
* **排查方式：**
  1. 讀 bridge `apply_config` 源碼,注意到 `k in CFG` 的白名單過濾;
  2. 對照 CFG 預設鍵名(snake_case)與 Host 送出名(camelCase);
  3. 發現 `cfg_path` 預設 `''` → Popen argv 出現 `--config ""` → 與錯誤訊息中的空路徑精確吻合。
* **最終解法：** alias 正規化(見 §3.5)；同場加映:TTS 錯誤訊息改為攜帶 HTTP 回應內文前 300 字，之後的 500 一眼看懂原因。

> **經驗萃取：**
> 「多個不相干症狀同時出現」優先找共同上游。錯誤訊息裡的**字面值**(`''`)可以直接反推代碼位置。

### 4.2 問題：播放順序亂跳

* **現象：** 先播後面、再播前面；斷句間距怪異。
* **實際原因：** 合成執行緒競爭入隊(§3.6)。
* **排查方式：**
  1. 確認派發端 seq 遞增無誤；
  2. 檢視 Player 入隊點，發現「誰先合成完誰先 append」；
* **最終解法：** seq 順序鎖。

> **經驗萃取：**
> 併發問題先用紙面推演「每個共享狀態的寫入點」，通常不必真的重現。

### 4.3 問題：長文朗讀在第 503 字戛然而止

* **現象：** 659 字故事，LLM 文字全出，語音停在約第 503 字(第 12 句)。
* **可能原因(使用者提出)：** GC 回收背景 task／佇列滿溢／順序鎖死鎖／HTTP timeout。
* **實際原因：** 宿主自己的 `maxTtsChars: 500` 上限——累積 503 字觸頂，dispatch 迴圈 break，後 15 句根本沒送出。503≈500 就是鐵證。
* **排查方式：**
  1. 對四個假設逐一對照實作(threading 不會被 GC/deque 無上限/哨兵防死鎖/timeout=300s)全數排除;
  2. 注意斷點數字與代碼常數的吻合。
* **最終解法：** 上限語義改「0=不限」、預設歸 0、**同步改掉已持久化的設定檔**(光改 DEFAULTS 沒用，載入時舊值會覆蓋)。

> **經驗萃取：**
> 怪現象先比對「斷點數字 vs 代碼裡的常數」。改預設值時記得檢查已存在的持久化資料。

### 4.4 問題：藍點顯示成灰色

* **現象：** 收音中圓點應為藍色，實呈灰色。
* **實際原因：** `var(--dsw-alias-brand-primary)` 在該主題未定義 → background 無效 → 透明透出底色。
* **排查方式：** CSS 變數逐一核對主題 token 清單。
* **最終解法：** 所有語意色帶 hex fallback。

> **經驗萃取：**
> 主題 token 是「可能有」不是「一定有」，fallback 是必要防禦。

### 4.5 問題：首輪語音延遲遠高於後續

* **現象：** 冷啟首輪 TTFT ~22s(甚至更久)，CLI 原生只要 7–10s。
* **實際原因：** 8081 **沒有 load 端點**，模型首次合成請求才懶載入(~15s)；疊加 §3.7 的全文等待。
* **排查方式：** 搜尋 audiocpp 文件/README 的模型管理端點；確認 `unload_models` 存在而 `load_models` 不存在。
* **最終解法：** 收音期間以極短合成預熱(藏在使用者說話時間內)+10 分鐘快取；冷啟降到 ~12s、熱啟 ~4s。

> **經驗萃取：**
> 「第一次慢、之後快」幾乎必然是懶載入/連線建立類問題；找出首次觸發點，把它搬到使用者無感的時間窗。

---

## 5. Plugin / Runtime 生命週期經驗

> 記錄動態 Plugin、程序、Bridge、Runtime 之間的生命週期關係。

### 5.1 動態 Plugin
* **已確認：**
  * define 只登記不執行；run/update 才啟動且需 UI 核准(awaiting-approval ≠ 啟動成功)。
  * update 失敗時 host-half 的錯誤訊息+stack 會回報，可直接定位代碼行；修正方式是**在同一 pluginId 上追加新 Package** 再 update，不是開新插件。
  * stop 保留定義與 grant；undefine 才永久刪除。
  * 使用者可隨時手動 stop/run(本次多次由使用者手動操作，均成功)。
* **限制：**
  * 不跨 DSH 程序生命週期；重啟即消失。
  * 單一 check mark 的 grant 只綁當前 Package。
* **容易誤解的地方：**
  * 「awaiting-approval」不代表在跑;「starting」也不代表成功——最終結果靠 steering 通知與 `cordis_inspect_self` 確認。
  * `currentPackageId` 在 update 失敗時不動(留在舊版)。

### 5.2 voice_bridge
* **負責：**
  * 8081 全部 HTTP 互動(models/unload/speech/transcriptions)、伺服器啟停與埠探活、模型單一化與預熱、麥克風收音+靜音偵測+辨識請求、WAV 解碼與有序播放。
* **不應負責：**
  * 對話狀態、turn 關聯、UI、設定決策——那些屬於 Host；bridge 只吃 config 執行。
* **介面：**
  * stdin JSON Lines 命令(ready/config/record/stop-record/speak/stop-playback/health/start-server/stop-server/models/ensure-single/unload/quit)；
  * stdout JSON Lines 事件(ready/config-ok/recording/asr-final/asr-cancelled/tts-queued/playback-drained/playback-stopped/health/server-started/server-stopped/models/single-ok/error)。
  * 帶 `req` 的命令由 Host 登記 resolver，逾時保證 resolve。

### 5.3 Process / Restart
* **實際行為：** Plugin stop → cleanup effect `terminate()` bridge；正常停止服務則走 `stop-server`+`quit` 讓 bridge 自己收尾再退出。8081 由 bridge 啟動時記 PID，外部啟動時以 netstat(Python 實作)找 PID 後 taskkill `/T /F`。
* **限制：** DETACHED_PROCESS 啟動的伺服器不受 bridge 死活影響；橋接崩了伺服器還在(health 探測會重新接上)。
* **經驗：** 週期性 health tick(5s)兼做 bridge 自癒——bridge 不在就重新 ensureBridge，服務狀態自然收斂。

---

## 6. Audio / ASR / TTS 整合經驗

### 6.1 ASR
* **輸入：** sounddevice 16kHz int16 麥克風流；靜音偵測(silence_seconds 0.8/threshold 0.01)自動截段。
* **輸出：** `/v1/audio/transcriptions` multipart → 文本；bridge 以 `asr-final {jobId,text}` 上拋。
* **注意事項：**
  * ASR 模型同樣懶載入；首次辨識前最好也有預熱(本次靠 TTS 預熱同輪觸發，未單獨驗證 ASR 預熱收益)。
  * 取消收音=`stop-record` 命令，bridge 回 `asr-cancelled`，Host 據此收圓而不注入。

### 6.2 Conversation Integration
* **正確流程：**
  1. Client Slot props 帶 `sessionId` → Host `state.sessionId`；
  2. `agents.get(sessionId)` 取 Agent(可選服務，需 undefined 防禦)；
  3. `agent.followup({id:'voice-<ts>-<rand>', role:'user', content:[{type:'text',text}], source:{kind:'user'}})`；
  4. `agent/inbox/claimed` 比對 `message.id` 綁定 `turn`；
  5. `session/event` 中過濾 `session.id===sessionId && data.turn===round.turn`。
* **關鍵實作：** 事件監聽全部 try/catch 包住——事件回呼拋例外會打斷其他消費者。
* **容易出錯的地方：**
  * 忘了 sessionId 可能為空(使用者沒開對話就點鈕)→ `no-session` 拒絕+toast；
  * `followup` 的 UserMessage 是純物件，欄位缺一不可(id/role/content/source)。

### 6.3 TTS
* **輸入：** `POST /v1/audio/speech` JSON:`{model, input, language}`＋克隆(`voice_ref` 路徑+`reference_text`)或內建(`options.speaker`)。
* **處理方式：** 回應 WAV → wave 解碼 → int16 PCM → 2048 frame chunk 入 deque；OutputStream callback 消費。
* **播放方式：** seq 順序鎖(§3.6)；callback 執行緒偵測 drained(expected==0 ∧ q 空 ∧ ready 空)後於副執行緒發事件，避免阻塞音訊。
* **注意事項：**
  * audio.cpp 不吃非 ASCII 路徑 → 克隆 wav 先複製 ASCII 副本；
  * 停止=gen 代數失效，在途合成結果整批丟棄；
  * 8GB 卡顯存：0.6B TTS+0.6B ASR 可共存(~3.8GB 駐留/峰值 5GB)；切 TTS 模型前先 unload 現役，否則 OOM 風險；
  * 模型懶載入，預熱=極短合成。

---

## 7. 非同步 / Streaming 經驗

> 只記錄實際驗證過的內容。

### 7.1 已驗證
* `assistant/chunk {turn, step, chunk:{type:'text-delta', index, text}}` 逐增量到達，可支撐邊生成邊念。
* 指標式掃描(`raw`+`pos`)在流上抽取完整句；句尾清洗/軟切/雜訊過濾後立即派發。
* seq 順序鎖下「生成未完、播放先行」的流水線穩定；drained 收圓正確。
* 停止播報時 gen 失效丟棄在途合成，無殘音。

### 7.2 已知限制
* 首句延遲底線=LLM 吐出第一句的時間+首句合成時間(~3–6s)；無法快過物理極限。
* 若某步 agent 回覆無文字(純工具)，該段無聲是預期行為。

### 7.3 尚未驗證
* reasoning 模型的 `reasoning-delta` 不會誤入朗讀(代碼已過濾 type，但未以推理模型實測)。
* 工具呼叫穿插多步回合中「分段文字」的朗讀順序(代碼支援，未專門測)。

### 7.4 可能需要特別注意
* 事件回呼內做了字串累積與 regex 掃描；超長回覆(萬字級)的 CPU 占用未量測。
* `feedStream` 內每輪 `slice(r.pos)` 在極長文本下是 O(n²) 風險——目前長度(數百~千字)無感，超大文本建議改 lastIndex 掃描。

---

## 8. 設定與環境經驗

### 8.1 設定來源
* `dsh_LocalAudio/runtime/voice-settings.json`(模型選擇/克隆預設/上限)；UI 寫入與 agent 寫入並存——**編輯前必重讀**。
* 永久化方向：移轉 DSH Settings namespace(本次以檔案先行)。

### 8.2 Port / Service

| 項目 | 用途 | 注意事項 |
| :--- | :--- | :--- |
| 8081 | audiocpp_server(ASR/TTS/模型管理) | 懶載入；無 load 端點；`loaded` 旗標在 unload 後可能殘留(HANDOFF 已知問題) |
| DSH GUI 3080 | 本插件的宿主與 UI | 動態插件跟著這個程序活 |
| venv python | bridge 執行環境 | `.assistant-venv`(numpy/requests/sounddevice) |

### 8.3 啟動方式
* 插件 apply 時自動 ensureBridge；bridge 收 config 後按需 start-server(使用者按「執行」或 health 發現埠活)。

### 8.4 重啟方式
* 設定頁「卸載」→ bridge stop-server(taskkill 樹刪)+quit；「執行」→ bridge Popen(detached) 重啟並輪詢埠。

### 8.5 常見環境問題
* 宿主子程序 spawn 外部 exe 曾出 0xc0000142(§3.4)。
* pwsh 沙箱禁止程式間管道捕獲(§3.8)；ConstrainedLanguage 限制 .NET 靜態呼叫。
* 主題 token 缺失導致透明色(§4.4)。

---

## 9. 成功實作模式

> 將這次實際成功的做法抽象成下一次可以參考的模式。只描述已驗證的思路。

### 9.1 建議架構
```
Client(Slot UI, 白名單 React)
   │ host.call(JSON RPC)            ▲ poll 狀態 + toast
   ▼
Host(狀態機 + 事件關聯 + 設定)
   │ JSON Lines(stdin/stdout)       ▲ 200ms offset 輪讀
   ▼
Bridge 常駐直譯器子程序(所有外呼/硬體/HTTP)
   │ HTTP
   ▼
領域服務(audio.cpp :8081)
```
三層各司其職：UI 永不失敗得無聲、Host 不碰 IO 細節、Bridge 不懂業務。

### 9.2 建議開發順序
1. 讀源碼確認契約(Service/Event/Slot/guard)→ 寫最小 Host+Client(一個 RPC + 一個 Slot)跑通核准流程。
2. 加 selftest Tool 實測宿主環境(spawn/路徑/網路)。
3. 立橋接層並內建 `--selftest`,脫離 UI 先驗證領域鏈路。
4. 接業務事件(收音→注入→串流→播放)，每步都有 toast/notice 可觀測。
5. 長文/中斷/重啟/冷啟等邊角案例收尾，寫驗收紀錄。

### 9.3 為什麼這樣做
每一層都可獨立驗證(UI 不用等領域通、領域不用等 UI)；故障域隔離後，除錯永遠只需看一層。

---

## 10. 不建議的做法

> 將本次經驗中確認不值得重複的做法集中整理。

| 做法 | 問題 | 建議 |
| :--- | :--- | :--- |
| 熱路徑 spawn 外部 exe | 環境性崩潰不可控 | 收進受控直譯器子程序 |
| 跨語言設定逐鍵盲覆蓋 | 靜默丟欄位→詭異二次症狀 | alias 正規化+config-ok 回顯 |
| 等全文再處理回應 | 延遲=總生成時間 | 用串流事件邊到邊處理 |
| 共享佇列無序寫入 | 播放亂序 | seq 順序鎖+失敗哨兵 |
| 護欄常數寫死且入持久化 | 需求演變後成暗雷 | 0=不限語義+改預設時同步遷移存量 |
| CSS 只寫 var() 無 fallback | 主題缺 token 即透明 | 一律 `, #hex` |
| 在沙箱裡用管道做整合測試 | 文件化禁區 | 內建 selftest 模式 |
| 失敗只回 ok:false 無 UI | 使用者以為按鈕壞了 | 每個拒絕都有 toast 文案 |

---

## 11. 驗收經驗

### 11.1 最小驗收流程
1. `*_selftest` Tool:宿主 spawn 能力+bridge/服務狀態一次看清。
2. bridge `--selftest`:config→埠→模型→合成→drained 離線全鏈。
3. UI 單輪語音：說→識別→注入→回覆→朗讀→復原。
4. 邊角：長文全文、播放中斷、藍/橘點、卸載↔重啟、冷熱啟 TTFT、toast 出現。

### 11.2 必須確認
- [ ] 每種拒絕路徑都有可見回饋
- [ ] 冷啟第一輪(模型載入)可用性
- [ ] 長文本不觸發任何隱性上限
- [ ] stop/update 後無孤兒程序(bridge、server)
- [ ] 設定變更經 UI 持久化並在新輪生效

### 11.3 容易漏掉的項目
* 已持久化設定覆蓋新預設值。
* 主題相關的視覺驗證只在單一主題做。
* 「使用者手動 stop→run」的路徑(agent 常只測自己的 update)。
* 錯誤訊息是否包含可定位的下文(如 HTTP 回應內文)。

---

## 12. 下一位 Plugin 開發者的建議

> 站在「已經走過這條路的人」的角度，給下一位開發者的實際建議。

* **建議 1:** 契約以 `packages/**/src` 源碼為唯一事實；工具鏈壞了就換工具，別換事實。
* **建議 2:** 第一支代碼就是 selftest Tool+bridge selftest 模式；之後每個疑難雜症都先量測再猜。
* **建議 3:** 使用者是最好的整合測試——把每個失敗路徑都做成一句人話 toast，回饋迴圈會快十倍。
* **建議 4:** 版本號(pkg-N)是你的朋友：大膽追加新版重跑，失敗的 stack 會直接告訴你哪一行錯。
* **建議 5:** 延遲問題先分段量測(ASR/LLM/TTS 各占多少)，本次 90% 的「TTS 很慢」最後都不是 TTS 的錯。

---

## 13. 經驗可信度

> 本節用來區分「實際驗證」與「推測」。

| 經驗 | 狀態 | 證據 / 來源 |
| :--- | :---: | :--- |
| 動態插件 define/run/update/stop 全流程 | ✅ 已驗證 | voice-1 九個 package、多次使用者手動操作 |
| Client builtin 白名單(useRef/setTimeout 不可用) | ✅ 已驗證 | define 前自查攔截+client-runner 源碼 |
| defineTool `parameters` DSL 與 output.schema 規範 | ✅ 已驗證 | guard.ts 源碼+兩次 host-half-failed 訊息 |
| 鍵名不匹配的靜默丟欄位症狀 | ✅ 已驗證 | 500 與 WinError 3 同根源修復後消失 |
| seq 順序鎖解決亂序 | ✅ 已驗證 | 659 字長文按序播畢 |
| assistant/chunk 串流管線 TTFT 3–4s | ✅ 已驗證 | 使用者實測(冷啟 12s/熱啟 ~4s) |
| maxTtsChars 截斷即長文中斷點 | ✅ 已驗證 | 503≈500 吻合，解除後全文通過 |
| 宿主 spawn curl 的 0xc0000142 | ⚠️ 部分驗證 | 當時重現、後續 selftest 又正常——環境性、不可依賴 |
| 沙箱禁管道捕獲 | ✅ 已驗證 | 文件化邊界+CreatePipe WinError 5 實測 |
| ASR 預熱的獨立收益 | ❓ Unknown | 未單獨量測 |
| 非 Windows 環境可行性 | ❌ 未適配 | 路徑/工作排程皆 Windows 特化 |

---

## 14. 本文件維護規則

1. 只加入實際開發中產生的可複用經驗。
2. 不把推測寫成已驗證事實。
3. 新發現的錯誤嘗試應記錄原因與最終解法。
4. 已經過時的內容應標記或修正。
5. 不將本文件當作新的開發 PLAN。
6. 不應因為下一個 Plugin 不同，就強行套用本文件所有做法。
