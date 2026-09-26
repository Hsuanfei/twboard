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
    raw=T.fetch_demo(code, days=240, seed=7)
    raw['dividends']=[]
    if code=='EVENT':raw['dividends']=[{'date':raw['bars'][-3]['date'],'kind':'除息','amount':2}]
    if code=='UNKNOWN':raw['dividends']=None
    return raw
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
(async()=>{
const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});let browser;
try{
 const port=await new Promise((resolve,reject)=>{let s='';child.stdout.on('data',d=>{s+=d;if(s.includes('\n'))resolve(Number(s.trim()));});child.on('error',reject);child.on('exit',c=>reject(Error('server '+c)));});
 browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});const page=await context.newPage();const errors=[];let jobs=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/jobs'))jobs++;});
 await page.goto('http://127.0.0.1:'+port);await page.locator('#f-code').fill('FULL,EVENT,UNKNOWN');await page.locator('#btn-go').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 3 / 3'));
 await page.locator('.analysis-tabs [data-view=bt]').click();
 assert.equal(await page.locator('.bt-table tbody tr').count(),5);assert.equal(await page.locator('#st-fee').inputValue(),'0.1425');
 await page.locator('#st-threshold').fill('0');await page.locator('#st-hold').fill('10');
 for(const f of ['fee','tax','slip'])await page.locator('#st-'+f).fill('0');
 await page.locator('#strategy-form button[type=submit]').click();assert(await page.locator('#strategy-chart').isVisible());
 assert((await page.locator('#strategy-trades').innerText()).includes('未平倉估值'));
 const original=await page.locator('.strategy-metrics b').first().innerText();
 await page.locator('#st-fee').fill('1');assert((await page.locator('#strategy-status').innerText()).includes('設定尚未套用'));await page.locator('#strategy-form button[type=submit]').click();assert.equal(await page.locator('#strategy-status').innerText(),'');
 const higher=await page.locator('.strategy-metrics b').first().innerText();assert(parseFloat(higher)<parseFloat(original),'Costs must reduce net return');
 const out=path.join(__dirname,'qa-strategy');fs.mkdirSync(out,{recursive:true});
 await page.locator('#btwrap').screenshot({path:path.join(out,'backtest-desktop.png')});
 await page.locator('#btn-cb').click();assert.equal(await page.locator('#strategy-chart canvas').count(),1);
 await page.locator('.analysis-tabs [data-view=all]').click();await page.locator('.analysis-tabs [data-view=bt]').click();assert.equal(await page.locator('#st-fee').inputValue(),'1');
 await page.locator('[data-code=EVENT]').click();await page.locator('#st-threshold').fill('0');await page.locator('#st-hold').fill('60');await page.locator('#strategy-form button[type=submit]').click();
 assert((await page.locator('#strategy-result').innerText()).includes('持倉跨除權息'));assert(await page.locator('#strategy-chart').isHidden());
 assert((await page.locator('#strategy-trades').innerText()).includes('跨除權息'));
 await page.locator('[data-code=UNKNOWN]').click();assert((await page.locator('#strategy-result').innerText()).includes('除權息資料未完整取得'));assert(await page.locator('#strategy-chart').isHidden());
 await page.locator('[data-code=FULL]').click();assert.equal(await page.locator('#st-fee').inputValue(),'1');
 await page.locator('#st-signal').selectOption('both');await page.locator('#st-segment').selectOption('late');await page.locator('#strategy-form button[type=submit]').click();
 assert.equal(jobs,3,'Replay must not fetch market data');
 let wait=page.waitForEvent('download');await page.locator('#st-csv').click();let d=await wait;await d.saveAs(path.join(out,'trades.csv'));
 const csv=fs.readFileSync(path.join(out,'trades.csv'),'utf8');assert.equal(csv.charCodeAt(0),0xfeff);assert(csv.includes('扣成本報酬%'));assert(!csv.includes('\\r\\n'));assert(csv.includes('"late"'));
 wait=page.waitForEvent('download');await page.locator('#dl-html').click();d=await wait;await d.saveAs(path.join(out,'report.html'));
 const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());await offline.goto('file:///'+path.join(out,'report.html').replace(/\\/g,'/'));
 await offline.locator('.analysis-tabs [data-view=bt]').click();assert.equal(await offline.locator('#st-fee').inputValue(),'1');assert.equal(await offline.locator('#st-signal').inputValue(),'both');assert.equal(await offline.locator('#st-segment').inputValue(),'late');
 await offline.locator('#st-reset').click();assert.equal(await offline.locator('#st-fee').inputValue(),'0.1425');await offline.close();
 await page.locator('#st-reset').click();assert.equal(await page.locator('#st-fee').inputValue(),'0.1425');
 await page.locator('#st-start').fill('2099-01-01');await page.locator('#strategy-form button[type=submit]').click();assert((await page.locator('#strategy-result').innerText()).includes('至少需要2'));assert(await page.locator('#strategy-chart').isHidden());
 await page.locator('#st-reset').click();await page.setViewportSize({width:390,height:900});await page.waitForTimeout(200);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('.strategy-panel').screenshot({path:path.join(out,'backtest-mobile.png')});
 assert.deepStrictEqual(errors,[]);console.log('PASS: simulation controls, cost sensitivity, open positions, corporate-event/unknown gates, chart lifecycle, per-stock settings, no refetch, CSV and frozen offline settings, empty/mobile layouts');
}finally{if(browser)await browser.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
