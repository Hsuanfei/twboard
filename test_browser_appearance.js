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
    raw['dividends']=[];raw['dividend_status']='confirmed'
    return raw
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;

(async()=>{
 const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});let browser;
 try{
  const port=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});child.on('error',reject);child.on('exit',c=>reject(Error('server '+c)));});
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});const page=await context.newPage();const errors=[];let jobs=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/jobs'))jobs++;});
  const out=path.join(__dirname,'qa-20260924a-appearance');fs.mkdirSync(out,{recursive:true});
  await page.goto('http://127.0.0.1:'+port);await page.locator('#f-code').fill('2330,MISS');await page.locator('#btn-go').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'));
  assert((await page.title()).includes('0930b'));
  const open=()=>page.locator('#chart-dialog').evaluate(n=>n.open);
  const dimensions=()=>page.locator('#k1').evaluate(n=>({w:n.clientWidth,h:n.clientHeight}));
  const size=await dimensions();
  await page.locator('#k1').click({position:{x:100,y:100}});assert(await open());
  // 0928a：主K線圖本來就整列寬，放大後主要是變高（寬度不縮水）
  assert((await dimensions()).w>=size.w*0.9);assert((await dimensions()).h>size.h*1.2);
  assert.equal(await page.locator('#zoom-host #k1').count(),1);
  await page.screenshot({path:path.join(out,'enlarged-desktop.png')});
  await page.locator('#k1').click({position:{x:100,y:100}});assert(!(await open()));assert.deepStrictEqual(await dimensions(),size);
  // Dragging a chart must not be mistaken for a click.
  const box=await page.locator('#k1').boundingBox();await page.mouse.move(box.x+100,box.y+100);await page.mouse.down();await page.mouse.move(box.x+170,box.y+100,{steps:5});await page.mouse.up();assert(!(await open()));
  for(const id of ['k3','k4','k5','k6','k7','k8','k11','k13','k15','k17']){
    const card=page.locator('#'+id).locator('xpath=ancestor::section');await card.locator('.chart-expand').click();assert(await open(),id);
    assert(await page.locator('#'+id).evaluate(n=>n.clientWidth>0&&n.clientHeight>0));await page.keyboard.press('Escape');assert(!(await open()));
  }
  await page.locator('.c1 .chart-expand').focus();await page.keyboard.press('Enter');assert(await open());
  await page.locator('#btn-bb').click();assert(await open(),'BB control should retain enlargement');
  await page.locator('#zoom-close').click();assert(!(await open()));assert.equal(await page.locator('.c1 .chart-expand').evaluate(n=>n===document.activeElement),true);
  const baseFont=await page.locator('#compare-head th').first().evaluate(n=>parseFloat(getComputedStyle(n).fontSize));
  const axisFont=await page.locator('#k1').evaluate(n=>echarts.getInstanceByDom(n).getOption().xAxis[1].axisLabel.fontSize);
  for(const scale of ['1.15','1.3']){
    await page.locator('#font-size').selectOption(scale);
    const current=await page.locator('#compare-head th').first().evaluate(n=>parseFloat(getComputedStyle(n).fontSize));assert(Math.abs(current-baseFont*Number(scale))<.1);
    const axis=await page.locator('#k1').evaluate(n=>echarts.getInstanceByDom(n).getOption().xAxis[1].axisLabel.fontSize);assert(Math.abs(axis-axisFont*Number(scale))<.1);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.screenshot({path:path.join(out,'large-desktop.png'),fullPage:true});
  await page.locator('[data-compare-row=MISS] button').click();assert.equal(await page.locator('#font-size').inputValue(),'1.3');
  await page.locator('.c8 .chart-expand').click();assert(await open());await page.locator('#zoom-close').click();
  await page.locator('[data-compare-row="2330"] button').click();assert.equal(jobs,2,'appearance never refetches');
  await page.setViewportSize({width:390,height:900});await page.waitForTimeout(250);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'large mobile width');
  const clipped=await page.locator('.grid .card').evaluateAll(ns=>ns.filter(n=>n.scrollHeight>n.clientHeight+3).map(n=>n.className));assert.deepStrictEqual(clipped,[],'large mobile cards clipped');
  await page.screenshot({path:path.join(out,'large-mobile.png'),fullPage:true});
  await page.locator('.c1 .chart-expand').click();await page.screenshot({path:path.join(out,'enlarged-mobile.png')});await page.locator('#zoom-close').click();
  await page.reload();await page.locator('#f-code').fill('2330,MISS');await page.locator('#btn-go').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'));assert.equal(await page.locator('#font-size').inputValue(),'1.3');
  await page.locator('.analysis-tabs [data-view=bt]').click();await page.locator('#strategy-chart').focus();await page.keyboard.press('Enter');assert(await open());await page.keyboard.press('Escape');assert(!(await open()));
  await page.locator('.analysis-tabs [data-view=all]').click();
  await page.locator('#font-size').selectOption('1');
  let waiting=page.waitForEvent('download');await page.locator('#dl-html').click();let dl=await waiting;const file=path.join(out,'offline.html');await dl.saveAs(file);
  const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());await offline.goto('file:///'+file.replace(/\\/g,'/'));
  await offline.locator('#font-size').selectOption('1.3');await offline.locator('.c1 .chart-expand').click();assert(await offline.locator('#chart-dialog').evaluate(n=>n.open));
  await offline.locator('#zoom-close').click();await offline.close();
  assert.deepStrictEqual(errors,[]);console.log('PASS: chart open/restore, all ECharts cards, empty cards, drag guard, keyboard/Escape/focus, control redraw, font UI/chart scaling/persistence, mobile, offline, no refetch');
 }finally{if(browser)await browser.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
