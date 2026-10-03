/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 20260924a：右上角「指標名詞解釋」— 位置、開關、搜尋、速查跳轉、目前數值、離線報告、手機版、列印。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const serverCode = `
import twboard as T, twserve as S
S.DEMO_MODE=True
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
function overlap(a,b){ return a.x<b.x+b.width && b.x<a.x+a.width && a.y<b.y+b.height && b.y<a.y+a.height; }
(async()=>{
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    const base='http://127.0.0.1:'+port;
    const output=path.join(__dirname,'qa-20260924a');fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch(launchOptions());
    const errors=[];
    const context=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    assert((await page.locator('h1').innerText()).includes('1003a'));
    assert((await page.title()).includes('1003a'));

    /* ---- 位置：頁首右上角，不壓到標題或表單 ---- */
    for(const width of [1920,1600,1200,900]){
      await page.setViewportSize({width,height:1000});
      const head=await page.locator('.app-head').boundingBox(), btn=await page.locator('#gl-open').boundingBox();
      assert(head.x+head.width-(btn.x+btn.width)<=16 && btn.y-head.y<=14,'按鈕應在頁首右上角 @'+width);
      for(const sel of ['.app-title h1','.app-credit','.app-title .tag','#f-code','#f-days','#f-source','#btn-go']){
        const box=await page.locator(sel).boundingBox();
        assert(!overlap(box,btn),sel+' 被名詞解釋按鈕蓋住 @'+width);
      }
    }
    await page.setViewportSize({width:1600,height:1000});
    await page.locator('.app-head').screenshot({path:path.join(output,'header-1600.png')});

    /* ---- 開啟：尚未載入個股 ---- */
    await page.locator('#gl-open').click();
    const dlg=page.locator('dialog#glossary');
    await dlg.waitFor({state:'visible'});
    const total=await page.evaluate(()=>TWGlossary.entries.length);
    assert(total>=60,'名詞數量 '+total);
    assert.equal(await dlg.locator('.gl-entry').count(),total);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'gl-q','開啟後焦點在搜尋框');
    assert((await page.locator('#gl-sub').innerText()).includes('載入個股後'));
    assert.equal(await dlg.locator('.gl-entry:not([data-cat=macro]) .gl-now').count(),0,'沒有個股時不顯示個股數值');
    await page.waitForFunction(()=>document.querySelector('#macro-tiles') && document.querySelector('#macro-tiles').children.length>0);
    assert.equal(await dlg.locator('.gl-index button').count(),await page.evaluate(()=>TWGlossary.index.length));
    await page.screenshot({path:path.join(output,'glossary-empty.png')});
    // 每個條目都有標題與至少一段說明
    const shape=await dlg.locator('.gl-entry').evaluateAll(ns=>ns.map(n=>({h:n.querySelector('h4').textContent.trim(),dd:n.querySelectorAll('dd').length})));
    assert(shape.every(s=>s.h&&s.dd>=1),'有空白條目');
    await page.keyboard.press('Escape');
    await dlg.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'gl-open','關閉後焦點回到按鈕');

    /* ---- 載入個股後：目前數值與畫面一致 ---- */
    await page.locator('#f-code').fill('2330');await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 1 / 1'));
    // 18 格名稱與速查表一致
    const cardNames=await page.evaluate(()=>TWGlossary.cards);
    for(let n=1;n<=18;n++){
      const h3=(await page.locator('.card.c'+n+' h3').innerText()).replace(/↓|⤢/g,'').replace(/\s+/g,'');
      const want=cardNames[n].replace(/\s+/g,'');
      assert(h3.startsWith(want),'第 '+n+' 格名稱不一致：'+h3+' vs '+want);
    }
    await page.locator('#gl-open').click();await dlg.waitFor({state:'visible'});
    assert((await page.locator('#gl-sub').innerText()).includes('2330'));
    const kdNow=await dlg.locator('#gl-e-kd .gl-now').innerText();
    const sub6=await page.locator('#t6sub').innerText();       // 「K 12.3　D 45.6」
    const k=sub6.match(/K\s*([\d.]+)/)[1], d=sub6.match(/D\s*([\d.]+)/)[1];
    assert(kdNow.includes('2330')&&kdNow.includes('K '+k)&&kdNow.includes('D '+d),'KD 目前值不一致：'+kdNow+' / '+sub6);
    const overallNow=await dlg.locator('#gl-e-overall .gl-now').innerText();
    const center=await page.evaluate(()=>TWBoard.payload().scores.overall);
    assert(overallNow.includes(center.toFixed(1)),'綜合分目前值不一致');
    const verdictNow=await dlg.locator('#gl-e-verdict .gl-now').innerText();
    assert(verdictNow.includes(await page.locator('#v-txt').innerText()));
    const withNow=await dlg.locator('.gl-now').count();
    assert(withNow>=40,'有目前數值的條目太少：'+withNow);
    assert(!(await dlg.innerText()).includes('undefined') && !(await dlg.innerText()).includes('NaN'),'出現 undefined/NaN');
    await page.screenshot({path:path.join(output,'glossary-2330.png')});

    /* ---- 搜尋 ---- */
    await page.locator('#gl-q').fill('乖離');
    const hits=await dlg.locator('.gl-entry:visible').evaluateAll(ns=>ns.map(n=>n.dataset.glId));
    assert(hits.includes('bias')&&hits.length<total,'搜尋乖離：'+hits.join(','));
    assert(await dlg.locator('[data-gl-sec=index]').isHidden());
    await page.locator('#gl-q').fill('adx');
    assert((await dlg.locator('.gl-entry:visible').evaluateAll(ns=>ns.map(n=>n.dataset.glId))).includes('dmi'),'英文不分大小寫');
    await page.locator('#gl-q').fill('完全不存在的字');
    assert(await dlg.locator('#gl-empty').isVisible());
    assert.equal(await dlg.locator('.gl-nav button:visible').count(),0);
    await page.locator('#gl-q').fill('');
    assert(await dlg.locator('#gl-empty').isHidden());
    assert.equal(await dlg.locator('.gl-entry:visible').count(),total);

    /* ---- 速查：點一格，只留那一格用到的名詞 ---- */
    await dlg.locator('.gl-index [data-gl-place="1"]').click();
    const card1=await dlg.locator('.gl-entry:visible').evaluateAll(ns=>ns.map(n=>n.dataset.glId));
    for(const id of ['ma','boll','fib','sr','vwap','unadjusted']) assert(card1.includes(id),'01 主K線圖應包含 '+id);
    assert(!card1.includes('margin')&&!card1.includes('kd'),'01 不該列出融資或 KD');
    assert((await dlg.locator('#gl-filter').innerText()).includes('01 主K線圖'));
    assert(await dlg.locator('[data-gl-sec=index]').isHidden());
    await page.screenshot({path:path.join(output,'glossary-card01.png')});
    await dlg.locator('[data-gl-all]').click();
    assert(await dlg.locator('#gl-filter').isHidden());
    assert.equal(await dlg.locator('.gl-entry:visible').count(),total);
    await dlg.locator('.gl-index [data-gl-place="cmp"]').click();
    const cmp=await dlg.locator('.gl-entry:visible').evaluateAll(ns=>ns.map(n=>n.dataset.where));
    assert(cmp.length>=8&&cmp.every(w=>w.split(',').includes('cmp')));
    await dlg.locator('[data-gl-all]').click();
    /* ---- 指定名詞跳轉與分類跳轉 ---- */
    await page.evaluate(()=>TWGlossary.open('kd'));
    await page.waitForTimeout(50);
    assert(await dlg.locator('#gl-e-kd').evaluate(n=>n.classList.contains('gl-hit')));
    const inView=await page.evaluate(()=>{const b=document.getElementById('gl-body').getBoundingClientRect(),e=document.getElementById('gl-e-kd').getBoundingClientRect();return e.top>=b.top-1&&e.top<b.top+60;});
    assert(inView,'KD 條目應捲到最上方');
    assert.equal(await dlg.locator('.gl-nav [aria-current=true]').innerText().then(t=>t.replace(/\d+$/,'').trim()),'動能指標');
    await dlg.locator('.gl-nav [data-gl-cat=macro]').click();
    await page.waitForTimeout(50);
    const secTop=await page.evaluate(()=>{const b=document.getElementById('gl-body').getBoundingClientRect(),s=document.querySelector('[data-gl-sec=macro]').getBoundingClientRect();return s.top-b.top;});
    assert(secTop>=-2&&secTop<40,'分類跳轉位置 '+secTop);
    // 搜尋中點速查：先清掉搜尋
    await page.locator('#gl-q').fill('布林');
    await page.evaluate(()=>TWGlossary.open('margin'));
    assert.equal(await page.locator('#gl-q').inputValue(),'');
    assert(await dlg.locator('#gl-e-margin').isVisible());
    // 點背景關閉
    await page.mouse.click(5,5);
    await dlg.waitFor({state:'hidden'});

    /* ---- 字體放大會跟著變 ---- */
    const fs1=await page.evaluate(()=>{TWGlossary.open();return parseFloat(getComputedStyle(document.querySelector('.gl-entry dl')).fontSize);});
    await page.evaluate(()=>TWGlossary.close());
    await page.locator('#font-size').selectOption('1.3');
    const fs2=await page.evaluate(()=>{TWGlossary.open();return parseFloat(getComputedStyle(document.querySelector('.gl-entry dl')).fontSize);});
    assert(fs2>fs1*1.2,'字體放大：'+fs1+' → '+fs2);
    await page.evaluate(()=>TWGlossary.close());
    await page.locator('#font-size').selectOption('1');

    /* ---- 列印時不出現 ---- */
    await page.emulateMedia({media:'print'});
    assert(await page.locator('#gl-open').isHidden());
    await page.emulateMedia({media:'screen'});

    /* ---- 離線報告：同樣有右上角按鈕，可離線打開 ---- */
    const snap=await page.evaluate(()=>TWBoard.payload().snapshot_id);
    const html=await (await page.request.get(base+'/api/export?snapshot='+encodeURIComponent(snap))).text();
    assert(html.includes('TWGlossary')&&html.includes('data-glossary-open'),'匯出檔要內嵌名詞解釋');
    const file=path.join(output,'offline.html');fs.writeFileSync(file,html);
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push('offline: '+e.message));
    await offline.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
    await offline.goto('file://'+file);
    const brand=await offline.locator('.export-brand').boundingBox(), obtn=await offline.locator('.export-brand .gl-open').boundingBox();
    assert(brand.x+brand.width-(obtn.x+obtn.width)<=20,'離線報告的按鈕在右上角');
    await offline.locator('.export-brand .gl-open').click();
    await offline.locator('dialog#glossary').waitFor({state:'visible'});
    assert((await offline.locator('#gl-e-rsi .gl-now').innerText()).includes('2330'));
    await offline.screenshot({path:path.join(output,'offline-glossary.png')});
    await offline.close();

    /* ---- 手機：只剩圖示、不壓標題；對話框全螢幕、不橫向捲動 ---- */
    const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
    const m=await mobile.newPage();m.on('pageerror',e=>errors.push('mobile: '+e.message));
    await m.goto(base);
    const mh=await m.locator('.app-head').boundingBox(), mb=await m.locator('#gl-open').boundingBox();
    assert(mb.width<=40&&mb.height<=40,'手機版只顯示圖示');
    assert(mh.x+mh.width-(mb.x+mb.width)<=14);
    assert(!overlap(await m.locator('.app-title h1').boundingBox(),mb),'手機版按鈕壓到標題');
    await m.locator('.app-head').screenshot({path:path.join(output,'header-mobile.png')});
    await m.locator('#f-code').fill('2330');await m.locator('#btn-go').click();
    await m.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 1 / 1'));
    await m.locator('#gl-open').click();await m.locator('dialog#glossary').waitFor({state:'visible'});
    const box=await m.locator('dialog#glossary').boundingBox();
    assert(box.width>=388&&box.height>=800,'手機版全螢幕');
    const noX=await m.evaluate(()=>{const b=document.getElementById('gl-body');return b.scrollWidth<=b.clientWidth+1;});
    assert(noX,'手機版內容不該橫向捲動');
    await m.locator('.gl-index [data-gl-place="4"]').click();
    await m.screenshot({path:path.join(output,'glossary-mobile.png')});
    await mobile.close();

    assert.deepEqual(errors,[]);
    console.log('PASS: top-right placement (1920/1600/1200/900/mobile, no overlap), '+total+' entries, focus in/out, Esc/backdrop close, search (zh/en/none), card index jump, category jump, live values match cards (KD/綜合分/研判, '+withNow+' entries), 18 card names match, font scaling, hidden in print, offline report works, mobile full-screen without horizontal scroll');
  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exit(1);});
