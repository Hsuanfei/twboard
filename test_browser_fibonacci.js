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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-fib-'));
const serverCode = `
import twboard as T, twserve as S
def fixture(code, display_days, *args, **kwargs):
    raw=T.fetch_demo(code, days=200, seed=sum(map(ord,code)))
    if code=='FLAT':
        for b in raw['bars']:
            b['open']=b['high']=b['low']=b['close']=100.0
    return raw
T.fetch_raw=fixture
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
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto('http://127.0.0.1:'+port);
    await page.locator('#f-code').fill('AAA,FLAT');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'),null,{timeout:60000});

    const lines=()=>page.evaluate(()=>{
      const o=echarts.getInstanceByDom(document.getElementById('k1')).getOption().series.filter(x=>x.name==='日K')[0];
      return {fib:((o.markLine||{}).data||[]).filter(m=>m.fibRatio!==undefined).map(m=>({r:m.fibRatio,y:m.yAxis,label:m.label.show})),
              area:((o.markArea||{}).data||[]).length};
    });
    // 預設開啟：七條線、38.2–61.8 色帶、讀數列
    let s=await lines();
    assert.deepStrictEqual(s.fib.map(x=>x.r),[0,0.236,0.382,0.5,0.618,0.786,1]);
    assert.equal(s.area,1);
    assert(s.fib.some(x=>x.label),'至少要有一條線標字');
    const info=await page.locator('#fib-info').innerText();
    assert(/費波南希回撤（30 日視窗）：(上升|下跌)波段/.test(info),info);
    assert((await page.locator('#fib-info').getAttribute('title')).includes('61.8%'));
    assert.equal(await page.locator('#btn-fib').getAttribute('aria-pressed'),'true');
    // 標字的線彼此之間要留得下標籤高度
    const shown=s.fib.filter(x=>x.label).map(x=>x.y).sort((a,b)=>a-b);
    const range=await page.evaluate(()=>{const y=echarts.getInstanceByDom(document.getElementById('k1')).getOption().yAxis[0];return y.max-y.min;});
    for(let i=1;i<shown.length;i++) assert(shown[i]-shown[i-1] > range*0.02,'標籤重疊');

    // 關閉：線、色帶、讀數都消失；卡片不被裁切
    await page.locator('#btn-fib').click();
    s=await lines();assert.equal(s.fib.length,0);assert.equal(s.area,0);
    assert(await page.locator('#fib-info').isHidden());
    assert.equal(await page.locator('#btn-fib').innerText(),'費波南希回撤：關');

    // 切換股票後保留開關狀態；再打開時，沒有價差的股票顯示原因而不是亂畫
    await page.locator('#compare-body [data-compare-row=FLAT] button').click();
    assert.equal(await page.locator('#btn-fib').getAttribute('aria-pressed'),'false');
    await page.locator('#btn-fib').click();
    s=await lines();assert.equal(s.fib.length,0);
    assert((await page.locator('#fib-info').innerText()).includes('沒有價差'));
    await page.locator('#compare-body [data-compare-row=AAA] button').click();
    s=await lines();assert.equal(s.fib.length,7);

    // 改分析天數，波段跟著視窗變
    await page.locator('#f-code').fill('AAA');await page.locator('#f-days').fill('120');await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('顯示 120'),null,{timeout:60000});
    assert((await page.locator('#fib-info').innerText()).includes('120 日視窗'));
    for(const width of [1600,900,390]){
      await page.setViewportSize({width,height:1000});await page.waitForTimeout(300);
      const clipped=await page.locator('.card').evaluateAll(ns=>ns.filter(n=>!n.hidden&&n.scrollHeight>n.clientHeight+2).map(n=>n.className));
      assert.deepStrictEqual(clipped,[],'Clipped card content at '+width);
    }
    await page.setViewportSize({width:1600,height:1100});

    // 離線匯出檔也有，而且開關可用
    const wait=page.waitForEvent('download');await page.locator('#dl-html').click();const d=await wait;
    const file=path.join(work,'report.html');await d.saveAs(file);
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());
    await offline.goto('file:///'+file.replace(/\\/g,'/'));await offline.waitForTimeout(800);
    assert((await offline.locator('#fib-info').innerText()).includes('120 日視窗'));
    assert((await offline.locator('#foot').innerText()).includes('沒有可靠的證據'));
    await offline.locator('#btn-fib').click();assert(await offline.locator('#fib-info').isHidden());
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: Fibonacci overlay default-on, 7 levels + golden zone, non-overlapping labels, readout/tooltip, toggle persists across stocks, flat-price reason, window follows days, responsive no clipping, offline export');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
