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
import datetime as dt, json, tempfile, time
from pathlib import Path
import twboard as T, twserve as S
cache=tempfile.TemporaryDirectory()
T.TC.CACHE_DIR=Path(cache.name)
broken=False

def http(url,params=None,**kwargs):
    time.sleep(.5)
    if broken: return None
    dataset=params['dataset']
    if dataset=='TaiwanStockInfo':return {'status':200,'data':[{'stock_id':'2330','stock_name':'測試台積電','type':'twse'}]}
    if dataset=='TaiwanStockDividendResult':return {'status':200,'data':[]}
    if dataset=='TaiwanStockPrice' and params['data_id'] in ('TAIEX','TPEx'):
        return {'status':200,'data':[{'date':d,'stock_id':params['data_id'],'close':20000+dt.date.fromisoformat(d).toordinal()%50}
                for d in T.TC.dates(params['start_date'],params['end_date']) if dt.date.fromisoformat(d).weekday()<5]}
    rows=[]
    for day in T.TC.dates(params['start_date'],params['end_date']):
        date=dt.date.fromisoformat(day)
        if date.weekday()>4:continue
        price=100+(date.toordinal()%37)
        if dataset=='TaiwanStockPrice':rows.append({'date':day,'open':price-1,'max':price+2,'min':price-2,'close':price,'Trading_Volume':1000000,'Trading_money':price*1000000,'Trading_turnover':100})
        elif dataset=='TaiwanStockInstitutionalInvestorsBuySell':
            rows.extend({'date':day,'name':name,'buy':2000,'sell':1000} for name in ['Foreign_Investor','Investment_Trust','Dealer_self'])
        else:rows.append({'date':day,'MarginPurchaseTodayBalance':100,'MarginPurchaseYesterdayBalance':90,'ShortSaleTodayBalance':10,'ShortSaleYesterdayBalance':10})
    return {'status':200,'data':rows}
T.http_get_json=http
class Handler(S.Handler):
    def do_POST(self):
        global broken
        if self.path=='/test/disk':
            S._cache.clear();return self._json({'ok':True})
        if self.path=='/test/failure':
            S._cache.clear()
            with T.TC.database() as db:db.execute('UPDATE cache SET fetched=0')
            broken=True
            return self._json({'ok':True})
        return super().do_POST()
server=S.ThreadingHTTPServer(('127.0.0.1',0),Handler)
print(server.server_address[1],flush=True)
try:server.serve_forever()
finally:cache.cleanup()
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
    const output=path.join(__dirname,'qa-20260924a');fs.mkdirSync(output,{recursive:true});
    const stages=new Set();const done=[];
    page.on('response',async r=>{
      if(r.url().includes('/api/jobs/')){
        const j=await r.json();if(j.ok){stages.add(j.job.stage);if(j.job.status==='done')done.push(j.job.data);}
      }
    });
    await page.goto('http://127.0.0.1:'+port);
    assert.equal(await page.locator('h1').innerText(),'台股戰略產生器1002a版');
    assert.equal(await page.locator('.app-credit').innerText(),'Powered by 黃炫斐(Mick Huang)');
    await page.locator('#f-code').fill('2330');
    await page.locator('#f-source').selectOption('finmind');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#load-stage').textContent.includes('股價'));
    assert.equal(await page.locator('#load-bar').getAttribute('value'),'0');
    await page.locator('.app-head').screenshot({path:path.join(output,'loading.png')});
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 1 / 1'));
    await page.waitForTimeout(50);
    assert(stages.has('股價'));const all=[...stages].join('|');assert(all.includes('三大法人'));assert(all.includes('融資融券'));   // 0922c：四個資料集同一階段平行抓
    assert.equal(done.at(-1).fetch_info.network_requests,7);   // 0928a：多一次近 10 年日K（型態歷史勝率），之後增量
    assert.equal(await page.locator('#load-bar').getAttribute('value'),'1');
    assert((await page.title()).includes('1002a'));
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled);
    await page.waitForTimeout(50);
    assert.equal(done.at(-1).fetch_info.mode,'memory');
    assert.equal(done.at(-1).fetch_info.network_requests,0);
    await page.request.post('http://127.0.0.1:'+port+'/test/disk');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled);
    await page.waitForTimeout(50);
    assert.equal(done.at(-1).fetch_info.mode,'local');
    assert.equal(done.at(-1).fetch_info.network_requests,0);
    assert(done.at(-1).fetch_info.reused_days>0);
    await page.locator('#f-days').fill('500');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled);
    await page.waitForTimeout(50);
    assert.equal(done.at(-1).fetch_info.network_requests,4);  // 法人、融資券補抓較早區間＋除權息（新區間）＋大盤基準；股價的較早區間已在 10 年歷史裡
    assert(done.at(-1).fetch_info.reused_days>0);
    assert.equal(done.at(-1).bars_count,500);
    await page.request.post('http://127.0.0.1:'+port+'/test/failure');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled);
    await page.waitForTimeout(50);
    assert(done.at(-1).fetch_info.warnings.length>0);
    assert((await page.locator('#h-meta').innerText()).includes('更新失敗'));
    assert.equal(done.at(-1).bars_count,500);
    const dl=page.waitForEvent('download');await page.locator('#dl-html').click();
    const download=await dl;await download.saveAs(path.join(output,'snapshot.html'));
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));
    await offline.goto(require('url').pathToFileURL(path.join(output,'snapshot.html')).href);
    assert((await offline.locator('.export-brand').innerText()).includes('台股戰略產生器1002a版'));
    assert((await offline.locator('.export-brand').innerText()).includes('Powered by 黃炫斐(Mick Huang)'));
    assert.equal(await offline.locator('#k1 canvas').count(),1);
    await page.screenshot({path:path.join(output,'complete.png'),fullPage:true});
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: title/credit, live stock/institution/margin stages, progress count, cold fetch, memory/disk hits, range extension, stale fallback warnings, branded offline export');

  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
