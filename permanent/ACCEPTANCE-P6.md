# P6 驗收清單(重啟後執行)

> 前置:DSH 已重啟、本檔所在 repo 在 `release` 分支。
> 動態插件 voice-1 已隨重啟消失(程序本地天性),永久版 dsh-voice 接手。

## 0. 掛載確認

- [ ] DSH 啟動無「dsh-voice」相關錯誤列
- [ ] `curl http://127.0.0.1:3080/api/dsh-voice/ping` → `{"ok":true,...,"stage":"P2"}`
- [ ] GUI 出現語音現語音圓鈕(輸入框右側)與設定頁「即時語音」區
- [ ] 設定頁診斷列:agents/subprocess/fs 全 ✓、bridge ✓

## 1. §15 端到端(與動態版同一份)

- [ ] 點鈕→藍點收音→靜默自動停→橘點播報→播完回 hidden
- [ ] ASR 文本帶 `(Voice) ` 前綴注入目前對話,觸發正常回覆
- [ ] 串流分句:長回答逐句播放,不整段等待(TTFT 體感雲端水準)
- [ ] 收音中再點=取消;播報中再點=立即停止(後續文本不再朗讀)
- [ ] 克隆音色:預設生效(工作區 reference WAV+文本),切換即時生效
- [ ] 模型下拉:TTS/ASR 列表來自 /v1/models 動態合併
- [ ] 服務控制:卸載釋放 8081(netstat 無 LISTENING)、執行可拉起
- [ ] Toast:錯誤/通知浮現 5 秒消失

## 2. 永久版專屬兩條

- [ ] **重啟自帶**:再次重啟 DSH 後語音功能直接在(免 define/run)
- [ ] **舊設定自動續用**:預設/模型沿用 runtime/voice-settings.json(未搬動、未損壞)

## 3. 回滾演練(僅記錄,不執行)

```
編輯 ~/.dsh/profiles/web/package.json:移除 bundles 內 "dsh-voice" 行
刪除 ~/.dsh/profiles/web/node_modules/dsh-voice/
重啟 DSH → 完全回到安裝前
```

## 通過後(P7)

1. PR `release` → `main`,審查後合併,tag `permanent-v1.0`
2. 動態側:cordis_undefine voice-1(或留著不影響,僅存檔)
