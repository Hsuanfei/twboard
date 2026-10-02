/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 1002a 強力分析：九個分頁都畫得出來（示範資料）、分頁切換只抓一次、重抓、自訂美股、K線／返回、名詞解釋、手機版、離線報告不顯示。 */
const {chromium,python,launchOptions}=require('./test_support');
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
(async()=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'twboard-1002a-ui-'));
 const child=spawn(python,['-B','-c',"import twserve as S; S.DEMO_MODE=True; s=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler); print(s.server_address[1],flush=True); s.serve_forever()"],{cwd:__dirname,windowsHide:true,env:{...process.env,TWBOARD_CACHE_DIR:path.join(work,'cache'),TWBOARD_DATA_DIR:work}});
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{child.stdout.once('data',d=>resolve(Number(d.toString().trim())));child.on('error',reject)});
  browser=await chromium.launch(launchOptions());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+port);
  await page.evaluate(()=>{window.testNow=Date.parse('2026-10-02T15:59:00Z');Date.now=()=>window.testNow;});
  const calls=[];page.on('request',r=>{if(r.url().includes('/api/power?'))calls.push(new URL(r.url()).searchParams.get('part'));});
  await page.evaluate(()=>TWPower.open('2330'));await page.locator('.pw-foot').waitFor();
  async function delayed(part,action){
   let release,ready;const gate=new Promise(r=>release=r),seen=new Promise(r=>ready=r);
   await page.route('**/api/power?*',async route=>{if(new URL(route.request().url()).searchParams.get('part')!==part)return route.continue();const response=await route.fetch();ready();await gate;try{await route.fulfill({response});}catch(e){/* aborted by switch/close */}});
   await page.locator('[data-pw-tab="'+part+'"]').click();await seen;await action();release();await page.waitForTimeout(300);await page.unroute('**/api/power?*');
  }
  await delayed('season',async()=>{await page.locator('[data-pw-tab="risk"]').click();});
  assert.equal(await page.locator('[aria-selected="true"][data-pw-tab]').getAttribute('data-pw-tab'),'risk');
  assert.equal(await page.locator('.pw-heat').count(),0);assert((await page.locator('#pw-body').innerText()).includes('夏普'));
  await delayed('margins',async()=>{await page.locator('#pw-close').click();});
  assert(!(await page.locator('#power').evaluate(e=>e.open)));
  await page.evaluate(()=>TWPower.open('2330'));await page.locator('.pw-foot').waitFor();
  await page.locator('[data-pw-tab="risk"]').click();await page.locator('.pw-foot').waitFor();
  const old=calls.length;
  await page.locator('#pw-close').click();await page.evaluate(()=>TWPower.open('2330'));await page.locator('.pw-foot').waitFor();assert.equal(calls.length,old,'fresh cache should be reused');
  await page.evaluate(()=>{window.testNow+=120000;window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelector('.pw-foot'));assert.equal(calls.length,old+1,'Taipei midnight must invalidate within TTL');
  const next=calls.length;
  await page.evaluate(()=>{window.testNow+=601000;window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelector('.pw-foot'));assert.equal(calls.length,next+1,'TTL must expire');
  const config=calls.length;await page.evaluate(()=>window.dispatchEvent(new Event('twboard-settings-changed')));await page.locator('.pw-foot').waitFor();assert.equal(calls.length,config+1,'settings must invalidate');
  assert.deepEqual(errors,[]);console.log('PASS: delayed tab race, close/reopen, fresh reuse, Taipei midnight, 10-minute expiry, settings invalidation');
 }finally{if(browser)await browser.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
