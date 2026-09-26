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
(async()=>{
 const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{let s='';child.stdout.on('data',d=>{s+=d;if(s.includes('\n'))resolve(Number(s.trim()));});child.on('error',reject);child.on('exit',c=>reject(Error('server '+c)));});
  browser=await chromium.launch(launchOptions());const ctx=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});const page=await ctx.newPage();const errors=[];let jobs=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/jobs'))jobs++;});
  await page.goto('http://127.0.0.1:'+port);await page.locator('#f-code').fill('SQ,UP,DOWN,FLAT,SHORT,BAD');await page.locator('#btn-go').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 5 / 6'));
  const codes=()=>page.locator('[data-compare-row]').evaluateAll(ns=>ns.map(n=>n.dataset.compareRow));
  const names=()=>page.evaluate(()=>echarts.getInstanceByDom(document.getElementById('k1')).getOption().series.map(s=>s.name));
  assert.deepStrictEqual(await codes(),['SQ','UP','DOWN','FLAT','SHORT']);
  assert((await names()).includes('布林上軌'));assert((await names()).includes('通道填色'));
  await page.locator('#btn-bb').click();assert(!(await names()).includes('布林上軌'));assert(await page.locator('#bb-info').isHidden());
  await page.locator('[data-compare-row=UP] button').click();assert.equal(await page.locator('#btn-bb').getAttribute('aria-pressed'),'false');
  await page.locator('#btn-bb').click();assert((await page.locator('#bb-info').innerText()).includes('今日突破上軌'));
  await page.locator('#btn-cb').click();assert((await names()).includes('布林上軌'));
  for(const [mode,expected] of [['squeeze',['SQ']],['break_up',['UP']],['break_down',['DOWN']],['above',['UP']],['below',['DOWN']]]){
   await page.locator('#filter-bb').selectOption(mode);assert.deepStrictEqual(await codes(),expected,mode);
   assert((await page.locator('[data-compare-code=BAD]').innerText()).includes('取得失敗'));
  }
  await page.locator('#filter-clear').click();await page.locator('#filter-rs').check();assert.deepStrictEqual(await codes(),['SQ','UP']);
  await page.locator('#filter-chip').check();assert.deepStrictEqual(await codes(),['SQ','UP']);
  await page.locator('#filter-score').fill('100');assert.deepStrictEqual(await codes(),[]);
  assert((await page.locator('#filter-count').innerText()).includes('下方仍顯示 UP'));
  await page.locator('#filter-clear').click();await page.locator('#filter-query').fill('short');assert.deepStrictEqual(await codes(),['SHORT']);
  await page.locator('#filter-bb').selectOption('squeeze');assert.deepStrictEqual(await codes(),[]);
  await page.locator('#filter-clear').click();await page.locator('[data-compare-sort=bb_percent_b]').click();
  assert.deepStrictEqual(await codes(),['UP','SQ','DOWN','FLAT','SHORT']); // nulls last
  await page.locator('#compare-reset').click();assert.equal(jobs,6,'Filtering must not refetch');
  const out=path.join(__dirname,'qa-bollinger');fs.mkdirSync(out,{recursive:true});
  await page.locator('#comparison').screenshot({path:path.join(out,'comparison.png')});
  await page.locator('.c1').screenshot({path:path.join(out,'bollinger-chart.png')});
  let waiting=page.waitForEvent('download');await page.locator('#dl-csv').click();let d=await waiting;await d.saveAs(path.join(out,'bollinger.csv'));
  const csv=fs.readFileSync(path.join(out,'bollinger.csv'),'utf8');assert(csv.includes('布林上軌2σ'));assert(csv.includes('價格報酬（不含息）'));
  waiting=page.waitForEvent('download');await page.locator('#dl-html').click();d=await waiting;await d.saveAs(path.join(out,'bollinger.html'));
  const offline=await ctx.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());
  await offline.goto('file:///'+path.join(out,'bollinger.html').replace(/\\/g,'/'));assert((await offline.locator('#bb-info').innerText()).includes('今日突破上軌'));
  await offline.locator('#btn-bb').click();assert(await offline.locator('#bb-info').isHidden());await offline.locator('#btn-bb').click();
  waiting=offline.waitForEvent('download');await offline.locator('#btn-main-png').click();d=await waiting;await d.saveAs(path.join(out,'bollinger.png'));assert(fs.statSync(path.join(out,'bollinger.png')).size>10000);
  await offline.locator('.analysis-tabs [data-view=raw]').click();assert((await offline.locator('#rawtab').innerText()).includes('布林%B'));await offline.close();
  await page.setViewportSize({width:390,height:900});await page.waitForTimeout(200);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#comparison').screenshot({path:path.join(out,'filters-mobile.png')});
  // A wholly successful new list can reach a true empty state; changing filters retains current chart.
  await page.locator('#f-code').fill('UP,SHORT');await page.locator('#btn-go').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'));
  await page.locator('#filter-query').fill('notfound');assert((await page.locator('#compare-body').innerText()).includes('沒有符合條件'));
  assert.equal(await page.locator('#h-code').innerText(),'UP');
  assert.deepStrictEqual(errors,[]);console.log('PASS: Bollinger overlay/fill/toggle, all filters/combinations/nulls/search, sorting/no-refetch, pending failures, empty selection state, CSV/offline HTML/PNG, mobile');
 }finally{if(browser)await browser.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
