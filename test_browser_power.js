/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 0930b 強力分析：九個分頁都畫得出來（示範資料）、分頁切換只抓一次、重抓、自訂美股、K線／返回、名詞解釋、手機版、離線報告不顯示。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-power-'));
const output = path.join(__dirname, 'qa-power'); fs.mkdirSync(output, {recursive: true});
const serverCode = `
import twserve as S
S.DEMO_MODE=True
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
const TABS = ['holders','risk','us','vp','foreign','short','margins','dividend','season'];
(async()=>{
  const env=Object.assign({},process.env,{TWBOARD_WATCHLIST_FILE:path.join(work,'w.json'),TWBOARD_FILTER_FILE:path.join(work,'f.json'),TWBOARD_CACHE_DIR:path.join(work,'cache'),TWBOARD_DATA_DIR:work});
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[],calls=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{ if(r.url().includes('/api/power')) calls.push(new URL(r.url()).searchParams); });
    await page.goto('http://127.0.0.1:'+port);
    assert.equal(await page.locator('h1').innerText(),'台股戰略產生器0930b版');
    // 還沒分析時，從精簡頁首打開：提示輸入代號
    await page.evaluate(()=>TWPower.open(''));
    await page.locator('dialog#power').waitFor({state:'visible'});
    assert((await page.locator('#pw-body').innerText()).includes('輸入股票代號'));
    assert.equal(await page.locator('#pw-tabs [role=tab]').count(),9);
    await page.locator('#pw-close').click();
    await page.locator('dialog#power').waitFor({state:'hidden'});

    await page.locator('#f-code').fill('6207');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>/完成 1 \/ 1 檔/.test(document.querySelector('#status').textContent));
    await page.locator('#btn-power').click();
    await page.locator('dialog#power').waitFor({state:'visible'});
    assert.equal(await page.locator('#pw-code').inputValue(),'6207');
    for(const tab of TABS){
      await page.locator('[data-pw-tab="'+tab+'"]').click();
      await page.waitForFunction(t=>document.querySelector('[data-pw-tab="'+t+'"]').getAttribute('aria-selected')==='true'&&document.querySelector('#pw-foot, .pw-foot'),tab,{timeout:30000});
      const text=await page.locator('#pw-body').innerText();
      assert(!text.includes('undefined')&&!text.includes('NaN'),tab+' 出現 undefined/NaN');
      assert(!text.includes('沒有可用的資料')||tab==='none',tab+'：'+text.slice(0,200));
      assert(await page.locator('#pw-body .pw-banner').count()>=1,tab+' 沒有摘要列');
      const charts=await page.locator('#pw-body .pw-chart').count();
      if(charts) assert.equal(await page.locator('#pw-body .pw-chart canvas').count(),charts,tab+' 圖表沒畫出來');
      assert((await page.locator('#pw-sub').innerText()).includes('測試樣本（6207）'));
      assert((await page.locator('.pw-foot').innerText()).includes('示範資料'));
      await page.screenshot({path:path.join(output,'power-'+tab+'.png')});
    }
    // 內容檢查：各頁的重點數字
    await page.locator('[data-pw-tab="risk"]').click();
    for(const label of ['年化報酬','夏普值','索提諾','卡瑪比','年化波動率','Beta','最大回撤','單日 VaR 95%','CVaR 95%']) assert((await page.locator('#pw-body').innerText()).includes(label),'風險缺 '+label);
    assert(/高風險|中風險|低風險/.test(await page.locator('.pw-level').innerText()));
    await page.locator('[data-pw-tab="dividend"]').click();
    assert(await page.locator('#pw-body table tbody tr').count()>=8,'填息紀錄太少');
    await page.locator('[data-pw-tab="season"]').click();
    assert.equal(await page.locator('#pw-body .pw-heat thead th').count(),13);
    assert((await page.locator('.pw-banner').innerText()).includes('本月'));
    // 同一分頁再開不重抓
    const before=calls.length;
    await page.locator('[data-pw-tab="risk"]').click();
    await page.locator('[data-pw-tab="season"]').click();
    assert.equal(calls.length,before,'切回已看過的分頁不該再查詢');
    await page.locator('#pw-refresh').click();
    await page.waitForFunction(n=>document.querySelector('.pw-foot'),before);
    assert.equal(calls[calls.length-1].get('refresh'),'1');

    // 美股：點列切換散佈圖、自訂代號
    await page.locator('[data-pw-tab="us"]').click();
    await page.locator('#pw-us-title').waitFor();
    assert.equal(await page.locator('[data-pw-us]').count(),6);
    await page.locator('[data-pw-us="NVDA"]').click();
    assert((await page.locator('#pw-us-title').innerText()).includes('輝達'));
    await page.locator('#pw-us-extra').fill('mu, avgo');
    await page.locator('#pw-us-apply').click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-pw-us]').length===8);
    assert.equal(calls[calls.length-1].get('us'),'MU, AVGO');
    assert(await page.evaluate(()=>JSON.parse(localStorage.getItem('twboard.power')).us==='MU, AVGO'));

    // 分價量切換區間
    await page.locator('[data-pw-tab="vp"]').click();
    await page.locator('[data-pw-vp="60"]').click();
    assert((await page.locator('[data-pw-vp="60"]').getAttribute('aria-pressed'))==='true');
    assert((await page.locator('.pw-banner .pw-bsub').innerText()).includes('60 個交易日'));

    // 名詞解釋疊在上面
    await page.locator('#pw-body [data-glossary-open]').first().click();
    await page.locator('dialog#glossary').waitFor({state:'visible'});
    assert(await page.locator('#gl-e-volume-profile').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('dialog#glossary').waitFor({state:'hidden'});
    assert(await page.locator('dialog#power').isVisible(),'關掉名詞解釋後，強力分析仍開著');

    // 換一檔代號直接分析
    await page.locator('#pw-code').fill('2330');
    await page.locator('#pw-go').click();
    await page.waitForFunction(()=>document.querySelector('#pw-sub').textContent.includes('（2330）'));

    // K線：回到主畫面並載入這一檔
    await page.locator('#pw-kline').click();
    await page.locator('dialog#power').waitFor({state:'hidden'});
    await page.waitForFunction(()=>/完成 1 \/ 1 檔 · 2330/.test(document.querySelector('#status').textContent),null,{timeout:30000});

    // 手機：不會出現橫向捲動，卡片兩欄
    await page.setViewportSize({width:390,height:860});
    await page.evaluate(()=>TWPower.open('2330'));
    await page.locator('[data-pw-tab="risk"]').click();
    await page.waitForSelector('#pw-body .pw-chart canvas');
    const overflow=await page.evaluate(()=>{ const b=document.querySelector('#pw-body'); return b.scrollWidth-b.clientWidth; });
    assert(overflow<=1,'手機版內容比畫面寬：'+overflow);
    await page.screenshot({path:path.join(output,'power-mobile.png')});
    await page.keyboard.press('Escape');
    await page.locator('dialog#power').waitFor({state:'hidden'});

    // 離線報告：沒有強力分析按鈕
    await page.setViewportSize({width:1600,height:1000});
    const wait=page.waitForEvent('download');await page.locator('#dl-html').click();const d=await wait;
    const html=path.join(work,'r.html');await d.saveAs(html);
    const offline=await context.newPage();await offline.route(/^https?:/,r=>r.abort());
    await offline.goto('file:///'+html.replace(/\\/g,'/'));await offline.waitForTimeout(400);
    assert(await offline.locator('#btn-power').isHidden());
    assert.equal(await offline.locator('dialog#power').count(),0);
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: power analysis — 9 tabs render with charts (demo), cached tab switching, refresh, US row pick + custom tickers, VP window, glossary on top, re-analyse code, K-line jump, mobile, hidden offline');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
