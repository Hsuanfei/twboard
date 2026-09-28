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
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1920,height:1200},acceptDownloads:true});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const output=path.join(__dirname,'qa-20260924a');fs.mkdirSync(output,{recursive:true});
    await page.goto('http://127.0.0.1:'+port);
    await page.locator('#f-code').fill('2360');await page.locator('#f-days').fill('100');await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 1 / 1'));
    assert((await page.locator('h1').innerText()).includes('0928a'));
    assert.equal(await page.locator('.card:visible').count(),18);
    assert(await page.locator('.compare-scroll').isHidden());
    await page.locator('#compare-toggle').click();assert(await page.locator('.compare-scroll').isVisible());
    await page.locator('#compare-toggle').click();
    for(const id of ['h-open','h-high','h-low','h-trades','h-days'])assert((await page.locator('#'+id).innerText()).trim());
    await page.screenshot({path:path.join(output,'dashboard-desktop.png'),fullPage:true});
    const positions=await page.locator('.card').evaluateAll(ns=>ns.map(n=>({c:n.className,y:n.getBoundingClientRect().y,w:n.clientWidth,h:n.clientHeight,overflow:n.scrollHeight-n.clientHeight})));
    assert.equal(new Set(positions.map(p=>p.y)).size,5,'0928a：主K線圖獨佔第一列，其餘 17 格排成 4 列');assert(positions.every(p=>p.overflow<=2),'Clipped desktop card');console.log('Card layout',positions);
    for(const [view,count] of [['risk',6],['kd',3],['macd',3],['raw',0],['bt',0],['all',18]]){
      await page.locator('.analysis-tabs [data-view='+view+']').click();assert.equal(await page.locator('.card:visible').count(),count);
      assert.equal(await page.locator('#tablewrap').isVisible(),view==='raw');
      assert.equal(await page.locator('#btwrap').isVisible(),view==='bt');
      if(view==='bt'){assert.equal(await page.locator('#btwrap .bt-table tbody tr').count(),5);assert((await page.locator('.bt-finding').innerText()).length>10);}
      if(view==='kd'||view==='macd')assert.equal(await page.locator('#k1 canvas').count(),1);
    }
    let wait=page.waitForEvent('download');await page.locator('#btn-main-png').click();let d=await wait;
    await d.saveAs(path.join(output,'main-chart.png'));assert(fs.statSync(path.join(output,'main-chart.png')).size>10000);
    wait=page.waitForEvent('download');await page.locator('[data-chart-png=k3]').click();d=await wait;
    await d.saveAs(path.join(output,'radar.png'));assert(fs.statSync(path.join(output,'radar.png')).size>10000);
    wait=page.waitForEvent('download');await page.locator('#dl-html').click();d=await wait;
    await d.saveAs(path.join(output,'report.html'));
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());
    await offline.goto('file:///'+path.join(output,'report.html').replace(/\\/g,'/'));
    assert((await offline.title()).includes('0928a'));assert(await offline.locator('#dl-csv').isHidden());
    await offline.locator('.analysis-tabs [data-view=raw]').click();assert(await offline.locator('#rawtab').isVisible());
    wait=offline.waitForEvent('download');await offline.locator('#btn-main-png').click();d=await wait;
    assert.equal(await offline.locator('.card:visible').count(),18);assert.equal(await d.failure(),null);
    await offline.close();
    for(const width of [1600,1366,900,390]){
      await page.setViewportSize({width,height:1000});await page.waitForTimeout(250);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'Page horizontal overflow at '+width);
      const clipped=await page.locator('.card').evaluateAll(ns=>ns.filter(n=>n.scrollHeight>n.clientHeight+2).map(n=>n.className));
      assert.deepStrictEqual(clipped,[], 'Clipped card content at '+width);
      await page.screenshot({path:path.join(output,'dashboard-'+width+'.png'),fullPage:true});
    }
    await page.locator('.c1').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'dashboard-mobile-detail.png')});
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: 18 cards/five rows (main chart full width), version/header fields, comparison collapse, 6 views incl. backtest, chart PNGs, offline report/PNG, responsive layouts, no browser errors');
  }finally{if(browser)await browser.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
