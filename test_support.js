/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
// 瀏覽器測試共用設定：Playwright、Python 與瀏覽器的位置。
//
// 優先順序：環境變數 → test_local.json（不進版控，放你自己機器的路徑）→ 預設值。
//   TWBOARD_TEST_PLAYWRIGHT  Playwright 模組路徑（預設 require('playwright')）
//   TWBOARD_TEST_PYTHON      Python 執行檔（預設 Windows 用 python，其餘用 python3）
//   TWBOARD_TEST_CHROMIUM    Chromium 執行檔路徑；沒給就用 channel
//   TWBOARD_TEST_CHANNEL     Playwright channel（預設 msedge）
const fs = require('fs');
const path = require('path');

let local = {};
try { local = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_local.json'), 'utf8')); } catch (e) { /* 沒有就用預設 */ }

function pick(envName, key, fallback) { return process.env[envName] || local[key] || fallback; }

let playwright;
try {
  playwright = require(pick('TWBOARD_TEST_PLAYWRIGHT', 'playwright', 'playwright'));
} catch (e) {
  console.error('找不到 Playwright。請先 npm install playwright，或在 test_local.json / TWBOARD_TEST_PLAYWRIGHT 指定模組路徑。');
  process.exit(2);
}

const python = pick('TWBOARD_TEST_PYTHON', 'python', process.platform === 'win32' ? 'python' : 'python3');

function launchOptions() {
  const exe = pick('TWBOARD_TEST_CHROMIUM', 'chromium', '');
  return exe ? { executablePath: exe, headless: true }
             : { channel: pick('TWBOARD_TEST_CHANNEL', 'channel', 'msedge'), headless: true };
}

module.exports = { chromium: playwright.chromium, python, launchOptions };
