/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 0930a：這次分析的全部股票一次下載成 Excel（總覽＋每檔一張工作表）；失敗的不放進去；本檔 CSV 仍可用。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-xlsx-'));
const serverCode = `
import twboard as T, twserve as S
def fixture(code, display_days, *args, **kwargs):
    if code=='BAD': return None
    return T.fetch_demo(code, days=180, seed=sum(map(ord,code)))
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
// 用標準函式庫讀下載的 xlsx：工作表名稱、總覽的代號、第一檔的列數
const reader = `
import sys, zipfile, re, json
z=zipfile.ZipFile(sys.argv[1]); wb=z.read('xl/workbook.xml').decode()
names=re.findall(r'<sheet name="([^"]+)"',wb)
ov=z.read('xl/worksheets/sheet1.xml').decode()
first=z.read('xl/worksheets/sheet2.xml').decode()
print(json.dumps({'names':names,'codes':re.findall(r'<c r="A\\d+"[^>]*t="inlineStr"><is><t[^>]*>([0-9A-Z]{3,6})</t>',ov),
                  'rows':first.count('<row ')}))
`;
(async()=>{
  const env=Object.assign({},process.env,{TWBOARD_WATCHLIST_FILE:path.join(work,'w.json'),TWBOARD_FILTER_FILE:path.join(work,'f.json'),TWBOARD_CACHE_DIR:path.join(work,'cache'),TWBOARD_DATA_DIR:work});
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    // Linux 沒設 UTF-8 語系時 Chromium 會把中文檔名改成 download；Windows 不受影響
    browser=await chromium.launch(Object.assign(launchOptions(),{env:Object.assign({},process.env,{LANG:process.env.LANG||'C.UTF-8'})}));
    const context=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+port);
    assert(await page.locator('#compare-xlsx').isHidden()||await page.locator('#compare-xlsx').isDisabled());
    await page.locator('#f-code').fill('AAA,BAD,BBB,CCC');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 3 / 4')&&!document.querySelector('#btn-go').disabled,null,{timeout:60000});
    assert.equal(await page.locator('#dl-xlsx').innerText(),'↓ 資料 Excel（全部 3 檔）');
    assert.equal(await page.locator('#compare-xlsx').innerText(),'↓ 全部資料 Excel（3 檔）');
    assert.equal(await page.locator('#dl-csv').innerText(),'↓ 本檔 CSV');
    assert((await page.locator('#dl-xlsx').getAttribute('title')).includes('AAA、BBB、CCC'));

    // 工具列按鈕：一次下載全部成功的股票，失敗的 BAD 不在裡面
    let wait=page.waitForEvent('download');await page.locator('#dl-xlsx').click();let d=await wait;
    assert(/^個股資料_\d{4}-\d{2}-\d{2}_3檔\.xlsx$/.test(d.suggestedFilename()),d.suggestedFilename());
    const file=path.join(work,'all.xlsx');await d.saveAs(file);
    const got=JSON.parse(execFileSync(python,['-c',reader,file]).toString());
    assert.deepEqual(got.names,['總覽','AAA 測試樣本','BBB 測試樣本','CCC 測試樣本']);
    assert.deepEqual(got.codes,['AAA','BBB','CCC']);
    assert(got.rows>=31,'第一檔工作表有分析天數的資料列＋標題：'+got.rows);
    assert((await page.locator('#status').innerText()).includes('已下載 3 檔的 Excel'));

    // 比較表上的按鈕也一樣；切換到別檔之後仍然是全部
    await page.locator('[data-compare-row=CCC] button').click();
    wait=page.waitForEvent('download');await page.locator('#compare-xlsx').click();d=await wait;
    await d.saveAs(path.join(work,'cmp.xlsx'));
    assert.deepEqual(JSON.parse(execFileSync(python,['-c',reader,path.join(work,'cmp.xlsx')]).toString()).names.length,4);

    // 本檔 CSV 只下載目前這一檔
    wait=page.waitForEvent('download');await page.locator('#dl-csv').click();d=await wait;
    assert(d.suggestedFilename().startsWith('CCC_'),d.suggestedFilename());

    // 手機：比較表按鈕可換行，不會撐出橫向捲動
    await page.setViewportSize({width:390,height:900});await page.waitForTimeout(250);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));

    // 離線匯出的報告沒有伺服器，不顯示下載按鈕
    await page.setViewportSize({width:1600,height:1000});
    wait=page.waitForEvent('download');await page.locator('#dl-html').click();d=await wait;
    const html=path.join(work,'report.html');await d.saveAs(html);
    const offline=await context.newPage();await offline.route(/^https?:/,r=>r.abort());
    await offline.goto('file:///'+html.replace(/\\/g,'/'));await offline.waitForTimeout(500);
    assert(await offline.locator('#dl-xlsx').isHidden());
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: Excel of all analysed stocks (overview + one sheet each, failed stock excluded) from toolbar and comparison table, per-stock CSV kept, labels/counts, mobile, hidden offline');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
