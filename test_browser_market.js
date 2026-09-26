/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 20260925a：市場掃描 — 選股清單、漲幅排行、ETF、族群輪動、概念族群編輯、到價警示、模擬持倉。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const serverCode = `
import os, tempfile
os.environ["TWBOARD_DATA_DIR"]=tempfile.mkdtemp(prefix="twboard-mk-")
import twboard as T, twserve as S
S.DEMO_MODE=True
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
const num=t=>Number(String(t).replace(/[^\d.+-]/g,''));
(async()=>{
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    const base='http://127.0.0.1:'+port;
    const output=path.join(__dirname,'qa-20260925a');fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch(launchOptions());
    const errors=[];
    const context=await browser.newContext({viewport:{width:1600,height:1000}});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    // 驗證失敗（400）是本測試故意觸發的，其他 console 錯誤都要算
    page.on('console',m=>{if(m.type()==='error'&&!/status of 400/.test(m.text()))errors.push(m.text());});
    await page.goto(base);
    assert((await page.locator('h1').innerText()).includes('20260925c'));
    await page.waitForFunction(()=>document.querySelector('#mk-meta').textContent.includes('尚未掃描'));
    assert.equal(await page.locator('#mk-scan').innerText(),'開始掃描');
    assert((await page.locator('#mk-note').innerText()).includes('第一次'));

    /* ---- 掃描 ---- */
    await page.locator('#mk-scan').click();
    await page.waitForFunction(()=>document.querySelector('#mk-scan').textContent==='更新掃描',null,{timeout:30000});
    assert((await page.locator('#mk-meta').innerText()).includes('資料日期'));
    const chips=await page.locator('#mk-screen-chips button').count();
    assert.equal(chips,8,'八種選股清單');
    const rows=await page.locator('#mk-screen-table tbody tr').count();
    assert(rows>=10&&rows<=40,'綜合強勢 '+rows+' 檔');
    const scores=await page.locator('#mk-screen-table tbody tr td:nth-child(11)').allInnerTexts();
    assert.deepEqual(scores.map(Number),scores.map(Number).slice().sort((a,b)=>b-a),'綜合強勢依分數排序');
    await page.locator('#market').screenshot({path:path.join(output,'screens.png')});
    // 創 60 日新高：每一列都要有這個標記
    await page.locator('[data-mk-screen=high60]').click();
    const tags=await page.locator('#mk-screen-table tbody tr td.mk-tags').allInnerTexts();
    assert(tags.length>0&&tags.every(t=>t.includes('60日新高')),'創新高清單都該有標記');
    assert((await page.locator('#mk-screen-rule').innerText()).includes('60 個交易日新高'));
    // 市場篩選
    await page.locator('[data-mk-screen=strong]').click();
    await page.locator('#mk-market').selectOption('上櫃');
    const markets=await page.locator('#mk-screen-table tbody tr td:nth-child(3)').allInnerTexts();
    assert(markets.length&&markets.every(m=>m==='上櫃'),'只看上櫃');
    await page.locator('#mk-market').selectOption('');

    /* ---- 點代號載入 18 格；勾選多檔一起分析 ---- */
    const first=await page.locator('#mk-screen-table tbody tr:first-child [data-mk-go]').getAttribute('data-mk-go');
    await page.locator('#mk-screen-table tbody tr:first-child [data-mk-go]').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 1 / 1'));
    assert.equal(await page.locator('#h-code').innerText(),first);
    const picks=page.locator('#mk-screen-table [data-mk-pick]');
    await picks.nth(1).check();await picks.nth(2).check();
    assert((await page.locator('#mk-analyse').innerText()).includes('2/10'));
    await page.locator('#mk-analyse').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'));

    /* ---- 漲幅排行 ---- */
    await page.locator('[data-mk-tab=rank]').click();
    let chg=(await page.locator('#mk-rank-table tbody td:nth-child(5)').allInnerTexts()).map(num);
    assert(chg.length>=10&&chg.every((v,i)=>!i||chg[i-1]>=v),'漲幅由大到小');
    await page.locator('[data-mk-rank=down]').click();
    chg=(await page.locator('#mk-rank-table tbody td:nth-child(5)').allInnerTexts()).map(num);
    assert(chg.every((v,i)=>!i||chg[i-1]<=v),'跌幅由小到大');
    await page.locator('[data-mk-rank=amount]').click();
    assert((await page.locator('#mk-rank-table thead').innerText()).includes('成交值'));

    /* ---- ETF ---- */
    await page.locator('[data-mk-tab=etf]').click();
    let etfs=await page.locator('#mk-etf-table tbody [data-mk-go]').evaluateAll(ns=>ns.map(n=>n.dataset.mkGo));
    assert(etfs.length&&etfs.every(c=>c.startsWith('00')),'只列 ETF');
    assert(!etfs.includes('00631L')&&!etfs.includes('00632R'),'預設不含槓桿／反向');
    await page.locator('#mk-etf-lev').check();
    etfs=await page.locator('#mk-etf-table tbody [data-mk-go]').evaluateAll(ns=>ns.map(n=>n.dataset.mkGo));
    assert(etfs.includes('00631L')&&etfs.includes('00632R'));
    assert((await page.locator('#mk-etf-table').innerText()).includes('債券'));

    /* ---- 族群輪動 ---- */
    await page.locator('[data-mk-tab=sector]').click();
    await page.waitForFunction(()=>document.querySelector('#mk-sector-chart canvas'));
    const sectorRows=await page.locator('#mk-sector-table tbody tr').count();
    assert(sectorRows>=10,'族群數 '+sectorRows);
    const quads=await page.locator('#mk-sector-table .mk-q').allInnerTexts();
    assert(quads.every(q=>['領漲','轉強','轉弱','落後'].includes(q)));
    await page.locator('#market').screenshot({path:path.join(output,'sector.png')});
    const name=await page.locator('#mk-sector-table tbody tr:first-child [data-mk-sector]').innerText();
    await page.locator('#mk-sector-table tbody tr:first-child [data-mk-sector]').click();
    assert(await page.locator('#mk-members').isVisible());
    assert((await page.locator('#mk-members').innerText()).includes(name));
    assert(await page.locator('#mk-member-table tbody tr').count()>=3);
    await page.locator('[data-mk-kind=概念]').click();
    const kinds=await page.locator('#mk-sector-table tbody td:nth-child(2)').allInnerTexts();
    assert(kinds.length&&kinds.every(k=>k==='概念'));
    // 排序
    await page.locator('[data-mk-sort=r20]').click();
    const r20=(await page.locator('#mk-sector-table tbody td:nth-child(6)').allInnerTexts()).map(num);
    assert(r20.every((v,i)=>!i||r20[i-1]>=v),'20 日由高到低');

    /* ---- 概念族群編輯 ---- */
    await page.locator('#mk-themes summary').click();
    await page.waitForFunction(()=>document.querySelectorAll('#mk-theme-rows .mk-theme').length>=10);
    const members=(await page.evaluate(()=>TWMarket.data().stocks.filter(s=>s.kind==='stock').slice(0,4).map(s=>s.code)));
    await page.locator('#mk-theme-add').click();
    const last=page.locator('#mk-theme-rows .mk-theme').last();
    await last.locator('input').fill('我的測試族群');await last.locator('textarea').fill(members.join(', '));
    await page.locator('#mk-theme-save').click();
    await page.waitForFunction(()=>document.querySelector('#mk-theme-msg').textContent.includes('已儲存'));
    await page.waitForFunction(()=>document.querySelector('#mk-sector-table').textContent.includes('我的測試族群'));
    assert((await page.locator('#mk-theme-state').innerText()).includes('自訂'));
    await page.locator('#mk-theme-rows .mk-theme').last().locator('textarea').fill('2330');
    await page.locator('#mk-theme-save').click();
    await page.waitForFunction(()=>document.querySelector('#mk-theme-msg').textContent.includes('2～60'));

    /* ---- 到價警示：從 18 格的按鈕預填 ---- */
    await page.locator('#btn-alert').click();
    await page.waitForFunction(()=>!document.querySelector('[data-mk-panel=alerts]').hidden);
    const cur=await page.locator('#h-code').innerText();
    assert.equal(await page.locator('#mk-al-code').inputValue(),cur);
    assert(Number(await page.locator('#mk-al-above').inputValue())>0,'預填上限');
    await page.locator('#mk-al-above').fill('1');await page.locator('#mk-al-below').fill('');
    await page.locator('#mk-alert-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#mk-alert-table').textContent.includes('新觸發'));
    assert.equal(await page.locator('#mk-alert-badge').innerText(),'1');
    await page.locator('#mk-al-ack').click();
    await page.waitForFunction(()=>document.querySelector('#mk-alert-badge').hidden);
    assert((await page.locator('#mk-alert-table').innerText()).includes('已觸發'));
    await page.locator('#mk-al-above').fill('10');await page.locator('#mk-al-below').fill('20');
    await page.locator('#mk-alert-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#mk-al-msg').textContent.includes('下限價要低於上限價'));

    /* ---- 模擬持倉 ---- */
    await page.locator('#btn-paper').click();
    await page.waitForFunction(()=>!document.querySelector('[data-mk-panel=paper]').hidden);
    assert.equal(await page.locator('#mk-pp-code').inputValue(),cur);
    assert(Number(await page.locator('#mk-pp-price').inputValue())>0,'預填收盤價');
    await page.locator('#mk-pp-lots').fill('2');
    await page.locator('#mk-paper-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#mk-paper-summary').textContent.includes('1 筆'));
    assert((await page.locator('#mk-paper-count').innerText()).includes('1'));
    const profit=num(await page.locator('#mk-paper-table tbody tr:first-child td:nth-child(8)').innerText());
    assert(profit<0,'同價買進，扣掉成本是小虧：'+profit);
    await page.locator('#mk-paper-table .mk-sell input').first().fill(String(Number(await page.locator('#mk-pp-price').inputValue())*1.2));
    await page.locator('[data-mk-sell]').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#mk-closed-table [data-mk-cdel]').length===1);
    assert(num(await page.locator('#mk-closed-table tbody td:nth-child(5)').innerText())>0);
    await page.locator('#market').screenshot({path:path.join(output,'paper.png')});

    /* ---- 名詞解釋有新功能的說明 ---- */
    await page.locator('#gl-open').click();
    await page.locator('#gl-q').fill('族群輪動');
    assert(await page.locator('#gl-e-sector-rotation').isVisible());
    assert((await page.locator('#gl-e-sector-rotation .gl-now').innerText()).includes('領漲'),'名詞解釋附上目前掃描結果');
    await page.locator('#gl-close').click();
    await page.locator('dialog#glossary').waitFor({state:'hidden'});

    /* ---- 收合狀態記在瀏覽器 ---- */
    await page.locator('#mk-toggle').click();
    assert(await page.locator('#mk-body').isHidden());
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#market').classList.contains('collapsed'));
    await page.locator('#mk-toggle').click();
    // 重新開啟頁面後，直接用本機快取顯示上次的掃描
    await page.waitForFunction(()=>document.querySelector('#mk-meta').textContent.includes('資料日期'));

    /* ---- 手機 ---- */
    const mobile=await browser.newContext({viewport:{width:390,height:844}});
    const m=await mobile.newPage();m.on('pageerror',e=>errors.push('mobile: '+e.message));
    await m.goto(base);
    await m.waitForFunction(()=>document.querySelector('#mk-meta').textContent.includes('資料日期'));
    for(const t of ['screens','sector','paper']){
      await m.locator('[data-mk-tab='+t+']').click();await m.waitForTimeout(150);
      assert(await m.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手機版 '+t+' 不該整頁橫向捲動');
    }
    await m.locator('[data-mk-tab=sector]').click();await m.waitForTimeout(200);
    await m.locator('#market').screenshot({path:path.join(output,'sector-mobile.png')});
    await mobile.close();

    assert.deepEqual(errors,[]);
    console.log('PASS: scan job, 8 screens (sorted, tagged, market filter), click-to-analyse + multi-select, gain/loss/amount ranking, ETF list with leveraged toggle, sector quadrant chart/table/members/sort, theme editor save + validation, price alerts from grid (trigger/badge/ack/validation), paper buy/sell P&L, glossary entry, collapse persisted, cached reload, mobile');
  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exit(1);});
