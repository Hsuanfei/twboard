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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-gm-'));
const serverCode = `
import twboard as T, twserve as S, twmacro as M
def fixture(code, display_days, *args, **kwargs):
    return T.fetch_demo(code, days=200, seed=sum(map(ord,code)))
T.fetch_raw=fixture
S.DEMO_MODE=True
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
(async()=>{
  const env=Object.assign({},process.env,{TWBOARD_WATCHLIST_FILE:path.join(work,'w.json'),TWBOARD_FILTER_FILE:path.join(work,'f.json'),TWBOARD_CACHE_DIR:path.join(work,'cache')});
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!/status of 400/.test(m.text()))errors.push(m.text());});
    await page.goto('http://127.0.0.1:'+port);

    // ---- 總體面板：進頁面就載入，五個磚、兩張圖、有註記 ----
    await page.waitForSelector('#macro:not([hidden])',{timeout:30000});
    await page.waitForFunction(()=>document.querySelectorAll('#macro-tiles .mtile').length===5);
    assert.equal(await page.locator('#macro-idx canvas').count(),1);
    assert.equal(await page.locator('#macro-fx canvas').count(),1);
    assert((await page.locator('#macro-tiles').innerText()).includes('美元兌台幣'));
    assert((await page.locator('#macro-tiles').innerText()).includes('日經 225'));
    assert((await page.locator('.macro-note').innerText()).includes('沒有加入任何評分'));
    const idxOpt=await page.evaluate(()=>{const o=echarts.getInstanceByDom(document.getElementById('macro-idx')).getOption();return {n:o.series.length,first:o.series.map(s=>s.data[0][1])};});
    assert.equal(idxOpt.n,4);idxOpt.first.forEach(v=>assert.equal(Math.round(v),100,'各線起點應為 100'));

    // ---- 群組：五組上限、八檔上限、逐檔加減、開啟即載入 ----
    await page.locator('#groups summary').click();
    assert((await page.locator('#g-count').innerText())==='');
    for(let i=0;i<5;i++){
      await page.locator('#f-code').fill('2330,2303');await page.locator('#g-name').fill('組'+i);await page.locator('#g-save').click();
      await page.waitForFunction(n=>document.querySelector('#g-msg').textContent.includes('已儲存「組'+n+'」'),i);
    }
    assert((await page.locator('#g-count').innerText()).includes('5 / 5'));
    await page.locator('#g-name').fill('第六組');await page.locator('#g-save').click();
    await page.waitForFunction(()=>document.querySelector('#g-msg').textContent.includes('上限'));
    assert.equal(await page.locator('#g-select option').count(),6);

    // 開啟群組：自動帶入並開始分析；成員面板出現
    await page.locator('#g-select').selectOption({label:'組0（2 檔）'});
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'),null,{timeout:60000});
    assert(await page.locator('#g-members').isVisible());
    assert.equal(await page.locator('#g-chips .g-chip').count(),2);
    assert((await page.locator('#g-chips').innerText()).includes('測試樣本'),'載入後顯示股票名稱');

    // 逐檔加入到 8 檔，第 9 檔被擋
    for(const c of ['2454','2317','2382','2308','3008','2881']){
      await page.locator('#g-add').fill(c);await page.locator('#g-add').press('Enter');
      await page.waitForFunction(x=>document.querySelector('#g-msg').textContent.includes('已把 '+x),c);
    }
    assert.equal(await page.locator('#g-chips .g-chip').count(),8);
    assert(await page.locator('#g-add-btn').isDisabled());
    assert(await page.locator('#g-add-current').isDisabled(),'目前股票已在群組內');
    // 移除一檔後可以再加
    await page.locator('[data-g-remove="2881"]').click();
    await page.waitForFunction(()=>document.querySelector('#g-msg').textContent.includes('移除 2881'));
    assert.equal(await page.locator('#g-chips .g-chip').count(),7);
    assert(!(await page.locator('#g-add-btn').isDisabled()));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.TWBOARD_WATCHLIST_FILE,'utf8'))['組0'].length,7,'檔案同步');

    // 「加入目前股票」：先看一檔不在群組裡的股票
    await page.locator('#f-code').fill('9999');await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 1 / 1'),null,{timeout:60000});
    await page.locator('#g-select').selectOption({label:'組0（7 檔）'});  // 選擇會載入 7 檔
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 7 / 7'),null,{timeout:120000});
    assert.equal(await page.locator('#chips .chip[data-code]').count(),7,'開啟群組就載入全部成員');
    // 重新載入同群組
    await page.locator('#g-reload').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('取得')||document.querySelector('#status').textContent.includes('完成 7 / 7'),null,{timeout:120000});
    // 刪除群組
    await page.locator('#g-del').click();
    await page.waitForFunction(()=>document.querySelector('#g-msg').textContent.includes('已刪除'));
    assert.equal(await page.locator('#g-select option').count(),5);
    assert(await page.locator('#g-members').isHidden());

    // 離線匯出也含總體面板
    const wait=page.waitForEvent('download');await page.locator('#dl-html').click();const d=await wait;
    const file=path.join(work,'report.html');await d.saveAs(file);
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());
    await offline.goto('file:///'+file.replace(/\\/g,'/'));await offline.waitForTimeout(1000);
    assert(await offline.locator('#macro').isVisible());assert.equal(await offline.locator('#macro-idx canvas').count(),1);
    assert.equal(await offline.locator('#macro-refresh').count(),0,'匯出檔沒有伺服器，不該有更新鈕');
    for(const width of [1600,900,390]){
      await page.setViewportSize({width,height:1000});await page.waitForTimeout(300);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
    }
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: macro panel on load (5 tiles, indexed chart, FX chart), group cap 5, per-group cap 8 with per-stock add/remove, open-loads-members, add-current guard, file sync, delete, offline export includes macro, no overflow');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
