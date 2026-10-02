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
    if code=='BAD':
        raise ValueError('offline test failure')
    raw=T.fetch_demo(code, days=80 if code=='SHORT' else 180, seed=sum(map(ord,code)))
    raw['name']='測試 <公司> & "名稱"' if code=='0050' else code+' 測試'
    if code=='MISS':
        raw['chips']={}; raw['margin']={}
    if code=='ZERO':
        raw['chips']={b['date']:{'foreign':0.,'trust':0.,'dealer':0.} for b in raw['bars']}
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
    await page.goto('http://127.0.0.1:'+port);
    assert(await page.locator('#comparison').isHidden());
    const codes=['0050','FULL','PART','SHORT','MISS','ZERO','BAD'];
    await page.locator('#f-code').fill(codes.join(','));
    await page.locator('#f-days').fill('500');
    let releaseFirst;
    const held=new Promise(resolve=>releaseFirst=resolve);
    let first=true;
    await page.route('**/api/jobs',async route=>{
      if(first){first=false;await held;}
      await route.continue();
    });
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#compare-body').textContent.includes('讀取中'));
    assert.equal(await page.locator('#compare-body tr').count(),7);
    assert((await page.locator('#compare-body tr').last().innerText()).includes('等待中'));
    releaseFirst();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 6 / 7'));
    assert((await page.locator('#compare-count').innerText()).includes('1 檔失敗'));
    assert((await page.locator('[data-compare-code="BAD"]').innerText()).includes('取得失敗'));
    assert.equal(await page.locator('[data-compare-code="BAD"] button').count(),0);
    assert((await page.locator('[data-compare-code="MISS"]').innerText()).includes('取得 0/5 日'));
    assert((await page.locator('[data-compare-code="PART"]').innerText()).includes('取得 2/5 日'));
    assert((await page.locator('#compare-note').innerText()).includes('日期不同'));
    assert((await page.locator('[data-compare-code="0050"]').innerText()).includes('測試 <公司> & "名稱"'));
    assert.equal(await page.locator('[data-compare-code="0050"] script').count(),0);
    const requestsBefore=urls.filter(u=>u.endsWith('/api/jobs')).length;
    const fields={close:d=>d.quote.close,change:d=>d.quote.chg_pct,volume:d=>d.quote.vol,
      ratio:d=>d.quote.vratio,net5:d=>d.chip.net5,net20:d=>d.chip.net20,score:d=>d.scores.overall,date:d=>d.last_date};
    const rowCodes=()=>page.locator('#compare-body tr').evaluateAll(rows=>rows.map(r=>r.dataset.compareCode));
    for(const [key,value] of Object.entries(fields)){
      for(const direction of [-1,1]){
        await page.locator('[data-compare-sort="'+key+'"]').click();
        const expected=codes.slice().sort((a,b)=>{
          const av=payloads[a]?value(payloads[a]):null,bv=payloads[b]?value(payloads[b]):null;
          if(av==null||bv==null)return av==null&&bv==null?codes.indexOf(a)-codes.indexOf(b):av==null?1:-1;
          const cmp=av<bv?-1:av>bv?1:0;
          return cmp?cmp*direction:codes.indexOf(a)-codes.indexOf(b);
        });
        assert.deepStrictEqual(await rowCodes(),expected,key+' '+direction);
        assert.equal(await page.locator('[data-compare-sort="'+key+'"]').evaluate(el=>el===document.activeElement),true);
      }
    }
    await page.locator('[data-compare-sort="code"]').click();
    assert.equal((await rowCodes())[0],'0050');
    await page.locator('#compare-reset').click();
    assert.deepStrictEqual(await rowCodes(),codes);
    await page.locator('[data-compare-code="ZERO"] .compare-pick').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#h-code').innerText(),'ZERO');
    assert.equal(await page.locator('[data-compare-code="ZERO"] .compare-pick').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-compare-code="ZERO"] .compare-pick').evaluate(el=>el===document.activeElement),true);
    assert((await page.locator('[data-compare-code="ZERO"] td').nth(5).innerText()).trim()==='0');
    assert.equal(urls.filter(u=>u.endsWith('/api/jobs')).length,requestsBefore);
    const output=path.join(__dirname,'qa-watchlist');fs.mkdirSync(output,{recursive:true});
    await page.locator('#comparison').screenshot({path:path.join(output,'comparison-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('.compare-scroll').evaluate(el=>el.scrollWidth>el.clientWidth));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.locator('.compare-scroll').evaluate(el=>el.scrollLeft=300);
    const rect=await page.locator('[data-compare-code="ZERO"] td').first().boundingBox();
    assert(rect.x>=0 && rect.x<390);
    await page.locator('#comparison').screenshot({path:path.join(output,'comparison-mobile.png')});
    await page.setViewportSize({width:1600,height:1100});
    await page.locator('#f-code').fill('BAD');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('全部取不到資料'));
    assert.equal(await page.locator('#compare-body tr').count(),1);
    assert(await page.locator('#stage').isHidden());
    assert(await page.locator('#dl-csv').isHidden());
    await page.locator('#f-code').fill('0050,0050,FULL');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'));
    assert.equal(await page.locator('#compare-body tr').count(),2);
    assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('twboard.prefs'))).code,'0050,0050,FULL');
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: loading/failure rows, eight metric sorts in both directions, zero vs null, leading-zero ticker, keyboard selection, no refetch, mixed-date warning, escaped names, desktop/mobile scrolling, all-failed reset, duplicate stocks');

  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
