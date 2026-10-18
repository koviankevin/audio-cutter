# 音剪 · Audio Cutter

留下想聽的部分。在瀏覽器內剪輯單一音檔，刪除多個段落、預聽結果，再匯出 MP3 或 WAV。

## 使用

1. 拖放或選擇 MP3、WAV，也可先按「示範音檔」。
2. 在波形上拖曳選段、拖動選段邊界，或輸入起點與終點。時間格式為 `01:23.456`，也接受秒數，例如 `83.456`。
3. 「刪除選段」剪去選取部分；「只保留選段」留下目前仍存在且位於選段內的音訊。可以連續操作，刪除過的聲音不會因再次選段而復活。
4. 預聽剪輯結果，或播放單一片段。剪輯按原始順序接合。
5. 選擇 MP3 或 WAV、修改檔名並匯出。若自動下載被阻擋，點選「下載完成的音檔」。

快捷鍵：空白鍵播放／暫停、Delete 刪除選段、Ctrl/Cmd+Z 復原、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做。輸入欄位內保留原本的文字編輯快捷鍵。在波形上使用左右方向鍵移動 0.1 秒，搭配 Shift 移動 1 秒。

## 格式、隱私與限制

- 輸入：MP3、WAV，最長 30 分鐘、最大 400 MiB、單聲道或雙聲道。其他容器、特殊 WAV 編碼或損毀檔案可能無法解碼。
- 以 44.1 kHz 解碼並處理，保留原始單／雙聲道。輸出為 MP3 192 kbps 或 WAV 16-bit PCM。MP3 會重新編碼，有少量編碼延遲；WAV 不會恢復有損來源已失去的細節。
- 剪輯保留原始樣本索引，播放及匯出使用同一份片段資料。復原記錄最多 100 個狀態，還原原檔也可以復原。
- 音檔不會傳送到網路；無分析追蹤、登入、雲端儲存或第三方字型。網站與編碼器初次載入仍需網路。
- 編輯狀態只存在目前頁面；關閉或重新整理即清除。尚未匯出的修改會觸發瀏覽器提醒。
- 取消匯出會立即終止背景 Worker。取消載入會忽略載入結果，但瀏覽器已開始的解碼仍可能短暫使用記憶體。
- 主要支援桌面版 Chrome 與 Edge。手機可基本操作，但大型檔案可能因記憶體不足而失敗。30 分鐘立體聲的解碼資料約占 606 MiB，處理尖峰可能更高。
- 第一版不包含多檔拼接、多軌、片段重排、降噪或語音辨識。

## 本機啟動

安裝 Node.js 22 或以上，於專案資料夾執行：

```sh
node scripts/serve.mjs
```

開啟 `http://127.0.0.1:4173/`。網站不需安裝任何套件或執行建置；請使用 HTTP 伺服器，直接雙擊 HTML 會受到模組與 Worker 安全限制。

## 測試

```sh
node --test tests/core.test.mjs
npm install
npx playwright install chromium
npm run test:browser
```

瀏覽器測試使用自己產生的音調資料，涵蓋多段剪輯、MP3/WAV 實際下載與解碼、左右聲道、播放與取消、錯誤檔案、鍵盤、子路徑及沒有音訊網路傳輸。需要測試已安裝的 Chrome／Edge 時可指定 `BROWSER_CHANNEL=chrome` 或 `BROWSER_CHANNEL=msedge`；`LONG_AUDIO=1` 另外測試 29 分鐘單聲道錄音。

測試會記錄網路請求；若主機防毒軟體注入自身的監控腳本，其已知網域請求會另列於 `environment-requests.json`，不視為應用程式請求。測試不會停用或修改防毒設定。

設定 `SITE_URL=https://koviankevin.github.io/audio-cutter/` 可對已部署網站執行相同的驗收流程。

## GitHub Pages

網站：[音剪](https://koviankevin.github.io/audio-cutter/)。公開儲存庫：[koviankevin/audio-cutter](https://github.com/koviankevin/audio-cutter)。

在 GitHub 儲存庫 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。

推送至 `main` 後，工作流程先執行核心測試，再以 `node scripts/package.mjs` 把公開資源複製到 `dist/`，最後部署到 GitHub Pages。部署只包含網站資源，不包含測試輸出或音檔。所有資源及 Worker 使用相對網址，可部署於 `/audio-cutter/` 子路徑。

## 技術與授權

原生 ES modules、Canvas、Web Audio API 與 Web Worker；無後端。介面、音訊、波形、剪輯區間與 PCM 編碼各自獨立。

應用程式採 MIT 授權。獨立的 MP3 編碼器 **lamejs 1.2.1** 採 LGPL-3.0，來源、固定版本雜湊與授權文件見 [`vendor/README.md`](vendor/README.md)。
