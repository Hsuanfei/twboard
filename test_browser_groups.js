/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-groups-'));
const serverCode = `
import twboard as T, twserve as S
def fixture(code, display_days, *args, **kwargs):
    raw=T.fetch_demo(code, days=200, seed=sum(map(ord,code)))
    if code=='NOBENCH':
        raw['bench']=None; raw['dividends']=[]
    return raw
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
(async()=>{
  const env=Object.assign({},process.env,{TWBOARD_WATCHLIST_FILE:path.join(work,'watchlists.json'),TWBOARD_CACHE_DIR:path.join(work,'cache')});
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    browser=await chromium.launch(launchOptions());
    const page=await browser.newPage({viewport:{width:1600,height:1100}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error' && !/status of 400/.test(m.text()))errors.push(m.text());}); // 400 是本測試刻意送出的無效群組名稱
    const base='http://127.0.0.1:'+port;
    await page.goto(base);

    // ---- 自選群組：儲存、驗證、重新載入後仍在、帶入、刪除 ----
    await page.locator('#groups summary').click();
    await page.locator('#f-code').fill('2330, NOBENCH');
    await page.locator('#g-save').click();
    await page.waitForFunction(()=>document.querySelector('#g-msg').textContent.includes('1～30'));
    await page.locator('#g-name').fill('<b>測試</b>群組');
    await page.locator('#g-save').click();
    await page.waitForFunction(()=>document.querySelector('#g-msg').textContent.includes('已儲存'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.TWBOARD_WATCHLIST_FILE,'utf8')),{'<b>測試</b>群組':['2330','NOBENCH']});
    await page.reload();
    await page.locator('#groups summary').click();
    assert.equal(await page.locator('#g-select option').count(),2);
    assert.equal(await page.locator('#g-select b').count(),0,'群組名稱必須跳脫');
    await page.locator('#f-code').fill('');
    await page.locator('#g-select').selectOption({index:1});
    assert.equal(await page.locator('#f-code').inputValue(),'2330,NOBENCH');
    const cross=await page.request.post(base+'/api/watchlists',{data:{name:'x',codes:'2330'},headers:{Origin:'https://other.example'}});
    assert.equal(cross.status(),403,'其他網站不可改群組');

    // ---- 相對大盤欄、除權息註記、回測分頁 ----
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'),null,{timeout:60000});
    const heads=await page.locator('#compare-head th').allInnerTexts();
    assert(heads.some(t=>t.includes('相對大盤20日')));
    const cells=await page.locator('#compare-body tr').evaluateAll(rs=>rs.map(r=>r.children[7].textContent.trim()));
    assert(/^[+-]?\d/.test(cells[0]) && cells[0].includes('點'),'有基準時顯示百分點：'+cells[0]);
    assert.equal(cells[1],'—','沒有基準時顯示 —，不補零');
    await page.locator('[data-compare-sort=rs20]').click();
    assert.equal(await page.locator('#compare-body tr').first().getAttribute('data-compare-code'),'2330','缺值固定排在有效數值之後');
    assert((await page.locator('#n1').innerText()).includes('除權息'));
    assert((await page.locator('#t2').innerText()).includes('相對大盤'));
    await page.locator('.analysis-tabs [data-view=bt]').click();
    assert.equal(await page.locator('#btwrap .bt-table tbody tr').count(),5);
    assert((await page.locator('#btwrap').innerText()).includes('不能拿來預測未來'));
    await page.locator('#compare-body [data-compare-row=NOBENCH] button').click();
    assert(await page.locator('#btwrap').isVisible(),'切換股票後仍停在回測分頁');
    assert(!(await page.locator('#n1').innerText()).includes('除權息'));

    await page.locator('#groups summary').click().catch(()=>{});
    if(!(await page.locator('#g-del').isVisible())) await page.locator('#groups summary').click();
    await page.locator('#g-select').selectOption({index:1});
    await page.locator('#g-del').click();
    await page.waitForFunction(()=>document.querySelector('#g-msg').textContent.includes('已刪除'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.TWBOARD_WATCHLIST_FILE,'utf8')),{});
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: group save/validate/persist/load/delete, escaped names, cross-origin blocked, RS column + null sort, ex-dividend note, backtest view survives stock switch');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
