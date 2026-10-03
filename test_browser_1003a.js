/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 1003a：右下角「資料來源」小視窗。用本機的假 FinMind（不連網）：用量計數與實際查詢一致、第二次分析沿用本機資料庫、
   連不上的來源顯示原因、額度用完（402）、回應緩慢、強力分析內的狀態列、清除本機資料庫、手機版、離線報告不顯示。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-1003a-ui-'));
const output = path.join(__dirname, 'qa-1003a'); fs.mkdirSync(output, {recursive: true});
const serverCode = `
import datetime as dt, json, socket
import twboard as T, twserve as S, twusage as U, twcache as C
from test_1003a import FakeFinMind
fake = FakeFinMind(last_day=C.today().isoformat())
def dead_url():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    return "http://127.0.0.1:%d/" % port
T.FINMIND = fake.url
T.DEFAULT_ENDPOINTS.update(finmind=fake.url, stooq=dead_url() + "stooq", yahoo=dead_url() + "yahoo/")
U.USER_INFO_URL = fake.user_info
server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
print(json.dumps({"port": server.server_address[1], "control": fake.control}), flush=True)
server.serve_forever()
`;
async function control(url, q){ const r = await fetch(url + (q ? '?' + q : '')); return r.json(); }
(async()=>{
  const env=Object.assign({},process.env,{TWBOARD_WATCHLIST_FILE:path.join(work,'w.json'),TWBOARD_FILTER_FILE:path.join(work,'f.json'),
    TWBOARD_CACHE_DIR:path.join(work,'cache'),TWBOARD_DATA_DIR:work});
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
  let browser;
  try{
    const info=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(JSON.parse(text.trim().split('\n')[0]));});
      child.stderr.on('data',()=>{});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    const base='http://127.0.0.1:'+info.port;
    browser=await chromium.launch(Object.assign(launchOptions(),{env:Object.assign({},process.env,{LANG:process.env.LANG||'C.UTF-8'})}));
    const context=await browser.newContext({viewport:{width:1500,height:950},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    assert.equal(await page.locator('h1').innerText(),'台股戰略產生器1003a版');
    const pill=page.locator('#us-pill');
    await pill.waitFor({state:'visible'});
    // 小按鈕在右下角
    const box=await pill.boundingBox();
    assert(box.x+box.width>1400 && box.y+box.height>900,'右下角：'+JSON.stringify(box));
    await page.waitForFunction(()=>/FinMind/.test(document.querySelector('#us-pill-text').textContent));

    /* ---- 分析一檔：用量＝實際送到 FinMind 的次數 ---- */
    await page.locator('#f-source').selectOption('finmind');
    await page.locator('#f-code').fill('2330');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>/完成 1 \/ 1 檔/.test(document.querySelector('#status').textContent),null,{timeout:60000});
    await page.evaluate(()=>TWUsage.poll());
    let calls=(await control(info.control)).calls;
    assert(calls>3,'FinMind 查詢次數 '+calls);
    let d=await page.evaluate(()=>TWUsage.data());
    assert.equal(d.finmind.used,calls,'小視窗的用量要等於實際查詢次數');
    assert.equal(d.finmind.limit,300);
    assert((await page.locator('#us-pill-text').innerText()).includes('FinMind '+calls+' / 300'));

    /* ---- 展開：FinMind 正常、Stooq 連不上（附原因）、本機資料庫 ---- */
    await pill.click();
    await page.locator('#us-panel').waitFor({state:'visible'});
    assert.equal(await pill.getAttribute('aria-expanded'),'true');
    const fmRow=page.locator('[data-us-src="FinMind"]');
    assert((await fmRow.innerText()).includes('正常'));
    await page.waitForFunction(()=>{const r=document.querySelector('[data-us-src="Stooq"]');return r&&/連線失敗/.test(r.textContent);},null,{timeout:20000});
    assert((await page.locator('[data-us-src="Stooq"]').innerText()).includes('拒絕'),'連不上要說明原因');
    assert((await page.locator('#us-fm').innerText()).includes('剩 '+(300-calls)+' 次'));
    assert((await page.locator('#us-fm').innerText()).includes('Token'),'沒有 Token 時提示可以提高額度');
    assert((await page.locator('#us-cache').innerText()).match(/\d+ 筆/));
    await page.locator('#us-cache details summary').click();
    assert((await page.locator('#us-cache').innerText()).includes('14:30'));
    await page.screenshot({path:path.join(output,'usage-panel.png')});

    /* ---- 再分析同一檔：直接用本機資料庫，不再查 FinMind ---- */
    await page.evaluate(()=>fetch('/api/cache/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirm":"no"}'}));
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>/完成 1 \/ 1 檔/.test(document.querySelector('#status').textContent)&&!document.querySelector('#btn-go').disabled,null,{timeout:60000});
    assert.equal((await control(info.control)).calls,calls,'同一檔再分析：0 次查詢');
    await page.locator('#us-refresh').click();
    await page.waitForFunction(()=>/省下/.test(document.querySelector('#us-cache').textContent));

    /* ---- 回應緩慢：等超過 8 秒時，小按鈕直接顯示在等誰 ---- */
    await control(info.control,'slow=11');
    await page.locator('#f-code').fill('2317');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>/等待 FinMind 回應/.test(document.querySelector('#us-pill-text').textContent),null,{timeout:30000});
    assert.equal(await page.locator('#us-dot').getAttribute('class'),'us-dot slow');
    assert(await page.locator('#us-now-box').isVisible());
    assert((await page.locator('#us-now').innerText()).includes('TaiwanStock'));
    await page.screenshot({path:path.join(output,'usage-slow.png')});
    await control(info.control,'slow=0');
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled,null,{timeout:120000});

    /* ---- 額度用完（HTTP 402）----*/
    await control(info.control,'quota=1');
    await page.locator('#f-code').fill('2454');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled,null,{timeout:60000});
    await page.evaluate(()=>TWUsage.poll());
    await page.waitForFunction(()=>/額度用完/.test(document.querySelector('#us-pill-text').textContent));
    assert.equal(await page.locator('#us-dot').getAttribute('class'),'us-dot limit');
    assert((await page.locator('#us-fm .us-alert.crit').innerText()).includes('查詢次數已達上限'));
    assert((await fmRow.innerText()).includes('額度用完'));
    await page.screenshot({path:path.join(output,'usage-limit.png')});
    await control(info.control,'quota=0');

    /* ---- 強力分析視窗裡也看得到 ---- */
    await page.locator('#us-close').click();
    await page.evaluate(()=>TWPower.open('2330'));
    await page.locator('dialog#power').waitFor({state:'visible'});
    await page.waitForFunction(()=>/FinMind/.test(document.querySelector('#pw-usage').textContent));
    await page.keyboard.press('Escape');
    await page.locator('dialog#power').waitFor({state:'hidden'});

    /* ---- 清除本機資料庫：要按兩次 ---- */
    await pill.click();
    await page.locator('#us-clear').click();
    assert((await page.locator('#us-clear').innerText()).includes('再按一次'));
    await page.locator('#us-clear').click();
    await page.waitForFunction(()=>/已清除 [\d,]+ 筆/.test(document.querySelector('#us-msg').textContent));

    /* ---- 名詞解釋 ---- */
    assert(await page.evaluate(()=>TWGlossary.entries.some(e=>e.id==='api-usage')&&TWGlossary.entries.some(e=>e.id==='cache-rules')));

    /* ---- 手機：不撐出橫向捲動、面板在畫面內 ---- */
    await page.setViewportSize({width:390,height:860});await page.waitForTimeout(300);
    const pb=await page.locator('#us-panel').boundingBox();
    assert(pb.x>=0&&pb.x+pb.width<=391,'手機版面板超出畫面：'+JSON.stringify(pb));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(output,'usage-mobile.png')});
    await page.locator('#us-close').click();

    /* ---- 離線報告沒有小視窗 ---- */
    await page.setViewportSize({width:1500,height:950});
    await page.locator('#f-code').fill('2330');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>!document.querySelector('#btn-go').disabled&&/完成/.test(document.querySelector('#status').textContent),null,{timeout:60000});
    const wait=page.waitForEvent('download');await page.locator('#dl-html').click();const dl=await wait;
    const html=path.join(work,'r.html');await dl.saveAs(html);
    const text=fs.readFileSync(html,'utf8');
    assert(!text.includes('id="usage"')&&!text.includes('TWUsage'),'離線報告不該有用量小視窗');
    assert.deepStrictEqual(errors,[]);
    console.log('PASS: usage meter — counts match real FinMind requests, repeat analysis uses disk cache, unreachable source reason, slow and 402 states, power-dialog line, clear cache, glossary, mobile, not in offline report');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
