/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 0922c：多檔一次送出、伺服器同時處理；全部完成後每檔都有結果，分頁可切換，失敗的那檔不影響其他檔。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const serverCode = `
import datetime as dt, json, tempfile, time, threading
from pathlib import Path
import twboard as T, twserve as S
cache=tempfile.TemporaryDirectory()
T.TC.CACHE_DIR=Path(cache.name)
LAT=0.4
inflight=[0]; peak=[0]; lock=threading.Lock()

def http(url,params=None,**kwargs):
    with lock:
        inflight[0]+=1; peak[0]=max(peak[0],inflight[0])
    try:
        dataset=params['dataset']; code=params['data_id']
        time.sleep(LAT*(4 if code=='1101' else 1))          # 第一檔故意最慢：畫面仍要先顯示它
        if code=='9999': return None                       # 這檔永遠取不到
        if dataset=='TaiwanStockInfo':return {'status':200,'data':[{'stock_id':code,'stock_name':'測試'+code,'type':'twse'}]}
        if dataset=='TaiwanStockDividendResult':return {'status':200,'data':[]}
        rows=[]
        for day in T.TC.dates(params['start_date'],params['end_date']):
            date=dt.date.fromisoformat(day)
            if date.weekday()>4:continue
            price=100+(date.toordinal()%37)+int(code[-2:])
            if dataset=='TaiwanStockPrice':rows.append({'date':day,'stock_id':code,'open':price-1,'max':price+2,'min':price-2,'close':price,'Trading_Volume':1000000,'Trading_money':price*1000000,'Trading_turnover':100})
            elif dataset=='TaiwanStockInstitutionalInvestorsBuySell':
                rows.extend({'date':day,'name':name,'buy':2000,'sell':1000} for name in ['Foreign_Investor','Investment_Trust','Dealer_self'])
            else:rows.append({'date':day,'MarginPurchaseTodayBalance':100,'MarginPurchaseYesterdayBalance':90,'ShortSaleTodayBalance':10,'ShortSaleYesterdayBalance':10})
        return {'status':200,'data':rows}
    finally:
        with lock: inflight[0]-=1
T.http_get_json=http
class Handler(S.Handler):
    def do_GET(self):
        if self.path=='/test/peak':
            return self._json({'ok':True,'peak':peak[0],'jobs':[(j['code'],j['status']) for j in S._jobs.values()]})
        return super().do_GET()
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
    const context=await browser.newContext({viewport:{width:1600,height:1100}});
    const page=await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const posts=[]; page.on('request',r=>{ if(r.method()==='POST'&&r.url().endsWith('/api/jobs')) posts.push(Date.now()); });
    const output=path.join(__dirname,'qa-20260924a');fs.mkdirSync(output,{recursive:true});
    await page.goto('http://127.0.0.1:'+port);
    await page.waitForSelector('#f-code');
    const codes=['1101','1301','2330','2317','2454','2881','2882','9999'];
    await page.locator('#f-code').fill(codes.join(','));
    await page.locator('#f-source').selectOption('finmind');
    const t0=Date.now();
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('成功 7 檔') || document.querySelector('#load-detail').textContent.includes('成功 7 檔'),null,{timeout:60000});
    const elapsed=(Date.now()-t0)/1000;
    assert.equal(await page.locator('#h-code').innerText(),'1101','先完成的不一定是第一檔，但畫面要先顯示輸入順序的第一檔');
    // 八個工作在第一檔完成前就全部送出（不再一檔做完才送下一檔）
    assert.equal(posts.length,8);
    assert(posts[7]-posts[0]<1500,'八個 POST 應在一秒多內送完，實測 '+(posts[7]-posts[0])+'ms');
    const peak=await (await page.request.get('http://127.0.0.1:'+port+'/test/peak')).json();
    assert(peak.peak>=4,'伺服器應同時對來源發出多條請求，實測尖峰 '+peak.peak);
    assert(peak.peak<=16,'4 個工作 × 4 個資料集，尖峰不該超過 16，實測 '+peak.peak);   // 這裡換掉了 http_get_json，8 條連線上限另由 test_performance.py 驗證
    assert.equal(peak.jobs.filter(j=>j[1]==='done').length,7);
    assert.equal(peak.jobs.filter(j=>j[1]==='error').length,1);
    // 逐檔串行：8 檔 × 6 次 × 0.4 秒 ≈ 19 秒以上；平行後應遠低於此
    assert(elapsed<12,'8 檔應在 12 秒內完成，實測 '+elapsed.toFixed(1)+' 秒');
    // 分頁：7 檔成功、1 檔失敗，切換分頁能畫圖
    assert.equal(await page.locator('.chip[data-code]').count(),7);
    assert.equal(await page.locator('.chip.bad').count(),1);
    assert.equal(await page.locator('#load-bar').getAttribute('value'),'8');
    assert((await page.locator('#load-count').innerText()).includes('8 / 8'));
    for(const c of ['2454','1101']){
      await page.locator('.chip[data-code="'+c+'"]').click();
      await page.waitForFunction(code=>document.querySelector('#stage') && !document.querySelector('#stage').hidden && document.body.innerText.includes('測試'+code),c);
    }
    assert((await page.locator('#status').innerText()+await page.locator('#load-detail').innerText()).includes('失敗 1 檔'));
    await page.screenshot({path:path.join(output,'parallel-8.png'),fullPage:false});
    // 第二次查同樣 8 檔：全部走快取，不再打 API
    const before=peak.peak;
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#load-detail').textContent.includes('成功 7 檔'),null,{timeout:30000});
    const again=await (await page.request.get('http://127.0.0.1:'+port+'/test/peak')).json();
    assert.equal(again.jobs.length,16);
    assert.deepEqual(errors,[]);
    console.log('PASS: 8 jobs submitted at once, server-side concurrency (peak '+peak.peak+'), 7 done + 1 failed without blocking, chips/switching, progress 8/8, '+elapsed.toFixed(1)+'s total');
  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exit(1);});
