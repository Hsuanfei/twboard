# 第三方元件聲明

本專案的程式碼依 GPL-3.0-only 釋出（見 `LICENSE`）。下列第三方元件隨本專案一併散布，各自依其原授權條款。

## Apache ECharts 5.5.1

- 檔案：`echarts.min.js`（取自 npm 套件 `echarts@5.5.1` 的 `dist/echarts.min.js`，未修改）
- 著作權：Copyright 2017-2024 The Apache Software Foundation
- 授權：Apache License 2.0（與 GPLv3 相容）
- 授權全文與其內含元件（zrender、d3 等）的授權：`licenses/ECharts-LICENSE.txt`
- NOTICE：`licenses/ECharts-NOTICE.txt`
- 官方網站：https://echarts.apache.org/

匯出的單檔 HTML 報告內嵌了 `echarts.min.js`，檔案開頭的 Apache 授權註解已完整保留。

## Python 標準函式庫

本專案執行時只使用 Python 標準函式庫，未隨附任何 Python 第三方套件。

## 開發與測試工具（不隨本專案散布）

瀏覽器測試使用 Playwright（Apache-2.0），需自行安裝，不包含在本專案內。

## 資料來源（不是軟體元件）

程式在使用者自己的電腦上，向下列來源取得公開行情資料。資料的權利屬於各來源，
本專案不包含、也不轉散布任何行情資料；使用者須自行遵守各來源的使用條款。

- FinMind：https://finmindtrade.com/
- 臺灣證券交易所：https://www.twse.com.tw/
