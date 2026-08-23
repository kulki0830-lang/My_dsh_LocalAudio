# P6 驗收清單(重啟後執行)

> 前置:DSH 已重啟、本檔所在 repo 在 `release` 分支。
> 動態插件 voice-1 已隨重啟消失(程序本地天性),永久版 dsh-voice 接手。
>
> **狀態:2026-08-23 全數通過。** 用戶實測回報為準,過程見 `PORTING-NOTES.md` 對應條目。

## 0. 掛載確認

- [x] DSH 啟動無「dsh-voice」相關錯誤列
- [x] `curl http://127.0.0.1:3080/api/dsh-voice/ping` → `{"ok":true,...}`
- [x] GUI 出現語音圓語音圓鈕(輸入框右側)與設定頁「即時語音」區
- [x] 設定頁診斷列:agents/subprocess/fs 全 ✓、bridge ✓

## 1. §15 端到端(與動態版同一份)

- [x] 點鈕→藍點收音→靜默自動停→橘點播報→播完回 hidden
- [x] ASR 文本帶 `(Voice) ` 前綴注入目前對話,觸發正常回覆
- [x] 串流分句:長回答逐句播放,不整段等待(TTFT 體感雲端水準)
- [x] 收音中再點=取消;播報中再點=立即停止(後續文本不再朗讀)
- [x] 克隆音色:預設生效(工作區 reference WAV+文本),切換即時生效
- [x] 模型下拉:TTS/ASR 列表來自 /v1/models 動態合併
- [x] 服務控制:卸載釋放 8081、執行可拉起
- [x] Toast:錯誤/通知浮現 5 秒消失

## 2. 永久版專屬兩條

- [x] **重啟自帶**:再次重啟 DSH 後語音功能直接在(免 define/run)
- [x] **舊設定自動續用**:預設/模型沿用 runtime/voice-settings.json(未搬動、未損壞)

### 加測項(驗收過程發現並修復)

- [x] 英文文本分句:句點邊界生效,小數/縮寫(Mr./Dr./e.g.)不誤切(`038cb02`)
- [x] 長英文段落:不再跳句、不再腰斬單字,詞流還原與原文一致(`fa730e1`)
- [x] 已知限制接受:串流 VoxCPM2 模型 500(retry_badcase 旗標,暫不處理)

## 3. 回滾演練(僅記錄,不執行)

```
編輯 ~/.dsh/profiles/web/package.json:移除 bundles 內 "dsh-voice" 行
刪除 ~/.dsh/profiles/web/node_modules/dsh-voice/
重啟 DSH → 完全回到安裝前
```

## 通過後(P7)——執行記錄

1. ✅ `release` → `main`:兩分支歷史無關(main 為清空佔位 ce85ff4),以 `--allow-unrelated-histories` 真
   合併等效於 GitHub PR merge;內容衝突一律取 release 側(`-X theirs`)
2. ✅ tag `permanent-v1.0`(annotated)打在 release 最終提交上
3. ✅ 動態側:voice-1 屬舊 session/程序本地定義,已隨多次乾淨重啟自然消失,當前 session 經
   inspect 確認無殘留——無需 cordis_undefine;其源碼保留於 `plugin/voice-1/` 作參照
   (已回修同源缺陷,見 PORTING-NOTES §五回修記錄)
