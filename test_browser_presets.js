/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
const { chromium, python, launchOptions } = require('./test_support');
const {spawn}=require('child_process');const fs=require('fs'),path=require('path'),assert=require('assert');
const serverCode=`
import twboard as T, twserve as S

def fixture(code, display_days, *args, **kwargs):
    if code=='BAD':raise ValueError('simulated data failure')
    raw=T.fetch_demo(code,days=80 if code=='SHORT' else 220,seed=7)
    for i,b in enumerate(raw['bars']):
        value=100
        if code=='SQ':value=100+(-1)**i*(10 if i<200 else .1)
        if code=='UP' and i==219:value=120
        if code=='DOWN' and i==219:value=80
        b.update(open=value,close=value,high=value+1,low=value-1)
        raw['chips'][b['date']]={'foreign':100 if code in ('UP','SQ') else -100,'trust':0,'dealer':0}
    raw['bench']={'id':'TAIEX','name':'Test price index','basis':'price','series':{b['date']:100 for b in raw['bars']}}
    raw['dividends']=[]
    raw['name']='測試 '+code
    return raw
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;

const os=require('os');
(async()=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'twboard-presets-'));
 const env={...process.env,TWBOARD_FILTER_FILE:path.join(work,'filters.json'),TWBOARD_CACHE_DIR:path.join(work,'cache')};
 const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{let s='';child.stdout.on('data',d=>{s+=d;if(s.includes('\n'))resolve(Number(s.trim()));});child.on('error',reject);child.on('exit',c=>reject(Error('server '+c)));});
  const base='http://127.0.0.1:'+port;
  browser=await chromium.launch(launchOptions());const ctx=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});const page=await ctx.newPage();
  const errors=[];let jobs=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/jobs'))jobs++;});
  await page.goto(base);await page.locator('#f-code').fill('SQ,UP,DOWN,FLAT,SHORT,BAD');await page.locator('#btn-go').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 5 / 6'));
  const codes=()=>page.locator('[data-compare-row]').evaluateAll(ns=>ns.map(n=>n.dataset.compareRow));
  await page.locator('#filter-chip').check();
  await page.locator('#preset-save').click();await page.waitForFunction(()=>document.querySelector('#preset-msg').textContent.includes('1～30'));
  const name='<b>法人買超</b>';
  await page.locator('#preset-name').fill(name);await page.locator('#preset-save').click();await page.waitForFunction(()=>document.querySelector('#preset-msg').textContent.startsWith('已儲存'));
  assert.equal(JSON.parse(fs.readFileSync(env.TWBOARD_FILTER_FILE,'utf8'))[name].chip,true);
  assert.equal(await page.locator('#preset-select b').count(),0);
  await page.locator('#filter-score').fill('101');assert(await page.locator('#filter-export').isDisabled());
  await page.locator('#filter-clear').click();await page.locator('#preset-select').selectOption(name);
  assert.deepStrictEqual(await codes(),['SQ','UP']);
  await page.locator('[data-compare-sort=close]').click();assert.deepStrictEqual(await codes(),['UP','SQ']);
  const out=path.join(__dirname,'qa-0920d');fs.mkdirSync(out,{recursive:true});
  let download=page.waitForEvent('download');await page.locator('#filter-export').click();let dl=await download;await dl.saveAs(path.join(out,'matches.csv'));
  const csv=fs.readFileSync(path.join(out,'matches.csv'),'utf8');assert.equal(csv.charCodeAt(0),0xfeff);
  const lines=csv.trim().split(/\r?\n/);assert.equal(lines.length,3);assert(lines[1].startsWith('"UP",'));assert(lines[2].startsWith('"SQ",'));assert(!csv.includes('"BAD"'));assert(csv.includes('法人5日買超：是'));assert(csv.includes('資料狀態'));
  await page.locator('#filter-bb').selectOption('below');assert(await page.locator('#filter-export').isDisabled());assert((await page.locator('#preset-msg').innerText()).includes('條件已調整'));
  await page.locator('#preset-select').selectOption(name);await page.locator('#comparison').screenshot({path:path.join(out,'comparison-desktop.png')});
  assert.equal(jobs,6,'Presets/filter/export must never fetch stock data');
  const cross=await page.request.post(base+'/api/filter-presets',{data:{name:'external',filters:'{}'},headers:{Origin:'https://other.example'}});assert.equal(cross.status(),403);
  const bad=await page.request.post(base+'/api/filter-presets',{data:{name:'bad',filters:'{"score":101}'}});assert.equal(bad.status(),400);
  const badType=await page.request.post(base+'/api/filter-presets',{data:{name:'bad',filters:1}});assert.equal(badType.status(),400);
  const badDelete=await page.request.post(base+'/api/filter-presets/delete',{data:{name:'missing'}});assert.equal(badDelete.status(),400);
  const page2=await browser.newPage({viewport:{width:390,height:900}});await page2.goto(base);await page2.locator('#f-code').fill('UP,SHORT');await page2.locator('#btn-go').click();await page2.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'));
  await page2.locator('#preset-select').selectOption(name);assert(await page2.locator('#filter-chip').isChecked());
  assert(await page2.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page2.locator('#comparison').screenshot({path:path.join(out,'comparison-mobile.png')});
  // Presets persist across browser contexts, support update, and can be removed without clearing active filters.
  await page2.locator('#filter-score').fill('70');await page2.locator('#preset-save').click();await page2.waitForFunction(()=>document.querySelector('#preset-msg').textContent.startsWith('已儲存'));
  assert.equal(JSON.parse(fs.readFileSync(env.TWBOARD_FILTER_FILE,'utf8'))[name].score,70);
  await page2.locator('#preset-delete').click();await page2.waitForFunction(()=>document.querySelector('#preset-msg').textContent.includes('已刪除'));
  assert.equal(await page2.locator('#filter-score').inputValue(),'70');assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.TWBOARD_FILTER_FILE,'utf8')),{});
  await page2.close();assert.deepStrictEqual(errors,[]);
  console.log('PASS: preset persistence across contexts, create/update/delete/validation, escaped names, CSV ordering/BOM/exclusions, no-refetch, origin protection, desktop/mobile');
 }finally{if(browser)await browser.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
