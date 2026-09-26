/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const serverCode = `
import twboard as T, twserve as S

def fixture(code, display_days, *args, **kwargs):
    raw=T.fetch_demo(code, days=80 if code=='SHORT' else 180, seed=7)
    if code=='MISS':
        raw['chips']={}; raw['margin']={}
    if code=='PART':
        for b in raw['bars'][-3:]:
            raw['chips'].pop(b['date'],None)
            raw['margin'].pop(b['date'],None)
    return raw
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
(async()=>{
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text=''; child.stdout.on('data',d=>{text+=d; if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[],urls=[]; const payloads={};
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>urls.push(r.url()));
    page.on('response',async r=>{
      if(r.url().includes('/api/jobs/')) {const j=await r.json(); if(j.ok&&j.job.status==='done')payloads[j.job.data.code]=j.job.data;}
    });
    await page.addInitScript(()=>localStorage.setItem('twboard.prefs',JSON.stringify({'a-token':'old-test-secret',code:'MISS,FULL,PART,SHORT',days:500})));
    await page.goto('http://127.0.0.1:'+port);
    assert(!await page.evaluate(()=>localStorage.getItem('twboard.prefs').includes('old-test-secret')));
    assert.equal(await page.locator('#a-token').getAttribute('type'),'password');
    await page.locator('#adv').evaluate(el=>el.open=true);
    await page.locator('#a-token').fill('new-test-secret');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 4 / 4'));
    assert.equal(await page.locator('#a-token').inputValue(),'');
    assert(!await page.evaluate(()=>localStorage.getItem('twboard.prefs').includes('test-secret')));
    assert((await page.locator('#w8').innerText()).includes('未取得'));
    await page.locator('[data-code="FULL"]').click();
    assert.equal(await page.locator('#k8 canvas').count(),1);
    assert.equal(await page.locator('#k15 canvas').count(),1);
    await page.locator('#btn-cb').click();
    assert.equal(await page.locator('#k8 canvas').count(),1);
    await page.locator('[data-code="PART"]').click();
    assert((await page.locator('#t8sub').innerText()).includes('資料不足'));
    assert((await page.locator('#l12').innerText()).includes('近5日資料不足'));
    assert(!(await page.locator('#l12').innerText()).includes('近5日法人賣超'));
    assert((await page.locator('#h-meta').innerText()).includes('落後股價'));
    await page.locator('[data-code="SHORT"]').click();
    assert((await page.locator('#b14').innerText()).includes('80 / 500'));
    assert((await page.locator('#status').innerText()).includes('SHORT'));
    assert((await page.locator('#status').innerText()).includes('80 / 500'));
    await page.locator('#f-days').fill('30');
    const output=path.join(__dirname,'qa-data-fix'); fs.mkdirSync(output,{recursive:true});
    const csvWait=page.waitForEvent('download');await page.locator('#dl-csv').click();
    const csv=await csvWait; await csv.saveAs(path.join(output,'snapshot.csv'));
    const rows=fs.readFileSync(path.join(output,'snapshot.csv'),'utf8').trim().split(/\r?\n/);
    assert.equal(rows.length,81); // currently shown 80 rows, not the edited 30-day form
    assert(rows[0].includes('產生時間')); assert(rows[80].endsWith(',500'));
    const htmlWait=page.waitForEvent('download');await page.locator('#dl-html').click();
    const html=await htmlWait;await html.saveAs(path.join(output,'snapshot.html'));
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));
    await offline.route(/^https?:/,route=>route.abort());
    await offline.goto('file:///'+path.join(output,'snapshot.html').replace(/\\/g,'/'));
    assert((await offline.locator('#b14').innerText()).includes('80 / 500'));
    assert.equal(await offline.locator('#k1 canvas').count(),1);
    await page.locator('#adv').evaluate(el=>el.open=false);
    await page.screenshot({path:path.join(output,'dashboard.png'),fullPage:true});
    await page.locator('#adv').evaluate(el=>el.open=true);
    await page.locator('#a-reset').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已清除'));
    assert(urls.every(url=>!url.includes('test-secret')&&!url.includes('token=')));
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: token migration, token body transport, missing/full/partial stock switching, palette redraw, 80/500 coverage, frozen CSV/HTML export, offline charts, token reset, no browser errors');
  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
