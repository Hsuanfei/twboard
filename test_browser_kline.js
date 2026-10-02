/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 0928a：主K線圖 — 區間切換、K 線型態標註與歷史勝率、跳空缺口、頭肩型態、籌碼成本分佈（POC／價值區）、
   開關記在瀏覽器、PNG、離線報告；以及捲動後出現的精簡頁首與全球市場收合。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twboard-kline-'));
const serverCode = `
import datetime as dt
import twboard as T, twserve as S
def hs_bars():
    # 頭肩底（最後 120 日內確認）＋ 一個尚未回補的向上跳空缺口
    anchors=[(0,100),(100,118),(160,95),(200,80),(212,92),(225,70),(238,93),(250,81),(265,100),(300,104)]
    closes=[]
    for (i0,p0),(i1,p1) in zip(anchors,anchors[1:]):
        closes+=[p0+(p1-p0)*(i-i0)/(i1-i0) for i in range(i0,i1)]
    closes.append(104.0)
    tail=[109+3*i/18 for i in range(19)]
    days=[];d=T.TC.today()
    while len(days)<len(closes)+len(tail):
        if d.weekday()<5: days.append(d.isoformat())
        d-=dt.timedelta(days=1)
    days.reverse()
    bars=[];prev=closes[0]
    for i,c in enumerate(closes+tail):
        o=prev if i!=len(closes) else 109.0
        bars.append({'date':days[i],'open':round(o,2),'high':round(max(o,c)+0.4,2),'low':round(min(o,c)-0.4,2),'close':round(c,2),
                     'vol':1000+(i%7)*150,'amount':1e8,'trades':100})
        prev=c
    return bars
def fixture(code, display_days, *args, **kwargs):
    raw=T.fetch_demo(code, days=220, seed=sum(map(ord,code)), history_days=1500)
    if code=='HS':
        raw['bars']=hs_bars(); raw['history']=None; raw['chips']={}; raw['margin']={}; raw['dividends']=[]
    return raw
T.fetch_raw=fixture
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
const option=(page)=>page.evaluate(()=>{
  const o=echarts.getInstanceByDom(document.getElementById('k1')).getOption();
  const by=id=>o.series.filter(s=>s.id===id)[0];
  return {n:o.xAxis[0].data.length, ids:o.series.map(s=>s.id).filter(Boolean), marks:(by('marks')||{data:[]}).data.map(d=>d.label.formatter),
          vp:by('vp')?by('vp').markLine.data.map(m=>[m.name,m.yAxis]):null, gaps:(by('gaps')||{data:[]}).data.length, hs:(by('hs')||{data:[]}).data.length};
});
(async()=>{
  const env=Object.assign({},process.env,{TWBOARD_WATCHLIST_FILE:path.join(work,'w.json'),TWBOARD_FILTER_FILE:path.join(work,'f.json'),TWBOARD_CACHE_DIR:path.join(work,'cache'),TWBOARD_DATA_DIR:work});
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true,env});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    const base='http://127.0.0.1:'+port;
    const output=path.join(__dirname,'qa-0928a');fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(base);
    await page.locator('#f-code').fill('AAA,HS');
    await page.locator('#btn-go').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2 / 2'),null,{timeout:60000});

    /* ---- 預設：近 120 日、型態與籌碼分佈開、布林與費波南希關；主K線圖獨佔一整列 ---- */
    assert.equal(await page.locator('#k-range').inputValue(),'120');
    const labels=await page.locator('#k-range option').allInnerTexts();
    assert.deepEqual(labels,['分析天數 30 日','近 60 日','近 120 日','近 250 日'],labels.join('|'));
    for(const [id,on] of [['btn-vp','true'],['btn-pat','true'],['btn-sr','true'],['btn-bb','false'],['btn-fib','false']])
      assert.equal(await page.locator('#'+id).getAttribute('aria-pressed'),on,id);
    assert.equal(await page.locator('#k-pats input[data-kpat]').count(),14);
    const grid=await page.locator('#analysis-grid').boundingBox(), c1=await page.locator('.c1').boundingBox();
    assert(c1.width>grid.width-4,'主K線圖整列寬');
    let o=await option(page);
    assert.equal(o.n,120);
    assert(o.ids.includes('k')&&o.ids.includes('vp')&&o.ids.includes('marks'),o.ids.join());
    assert.deepEqual(o.vp.map(x=>x[0]),['VAH','POC','VAL']);
    const [vah,poc,val]=o.vp.map(x=>x[1]);assert(val<poc&&poc<vah,'VAL < POC < VAH');
    assert(o.marks.length>0&&o.marks.every(t=>/^[▲▼◆]/.test(t)),o.marks.join());
    const summary=await page.locator('#k-summary').innerText();
    assert(summary.includes('POC')&&summary.includes('價值區')&&summary.includes('▲多方'),summary);
    await page.locator('.c1').screenshot({path:path.join(output,'kline-default.png')});

    /* ---- 滑鼠移到標記：歷史勝率 ---- */
    const target=await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('k1'));const m=c.getOption().series.filter(s=>s.id==='marks')[0].data;const d=m[Math.floor(m.length/2)];return c.convertToPixel({xAxisIndex:0,yAxisIndex:0},d.value);});
    await page.locator('#k1').scrollIntoViewIfNeeded();
    const box=await page.locator('#k1').boundingBox();
    await page.mouse.move(box.x+target[0],box.y+target[1]);
    await page.waitForFunction(()=>/上漲機率/.test(document.querySelector('#k1').innerText));
    const tip=await page.locator('#k1').innerText();
    assert(/5 日上漲機率 \d+%（近 [\d.]+ 年 n=\d+，平均 [+−-]?[\d.]+%）/.test(tip)||tip.includes('歷史上沒有可統計的樣本'),tip);
    assert(tip.includes('對照：全部交易日'),tip);
    await page.screenshot({path:path.join(output,'kline-tooltip.png')});
    await page.mouse.move(5,5);

    /* ---- 型態勾選：只拿掉十字線；關掉型態標註整列隱藏 ---- */
    await page.locator('#k-pats input[data-kpat=doji]').uncheck();
    o=await option(page);assert(!o.marks.some(t=>t==='◆十'),'十字線已隱藏');
    await page.locator('#btn-pat').click();
    o=await option(page);assert(!o.ids.includes('marks'));assert(await page.locator('#k-pats').isHidden());
    await page.locator('#btn-pat').click();
    assert(await page.locator('#k-pats').isVisible());assert(!(await page.locator('#k-pats input[data-kpat=doji]').isChecked()));

    /* ---- 區間 250 日、費波南希跟著區間；籌碼分佈關閉 ---- */
    await page.locator('#k-range').selectOption('250');
    await page.locator('#btn-fib').click();
    o=await option(page);assert.equal(o.n,250);
    assert((await page.locator('#fib-info').innerText()).includes('250 日視窗'));
    await page.locator('#btn-vp').click();
    o=await option(page);assert.equal(o.vp,null);assert(!(await page.locator('#k-summary').innerText()).includes('POC'));
    await page.locator('#btn-vp').click();

    /* ---- 縮放 K 棒：籌碼分佈用可見區間重算 ---- */
    const before=(await option(page)).vp;
    await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('k1'));c.dispatchAction({type:'dataZoom',dataZoomIndex:0,start:80,end:100});});
    await page.waitForFunction(b=>{const c=echarts.getInstanceByDom(document.getElementById('k1'));const m=c.getOption().series.filter(s=>s.id==='vp')[0].markLine.data;return m[1].yAxis!==b;},before[1][1]);
    await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('k1'));c.dispatchAction({type:'dataZoom',dataZoomIndex:0,start:0,end:100});});

    /* ---- 符號說明與歷史勝率表 ---- */
    await page.locator('#k-legend summary').click();
    const rows=await page.locator('#k-legend-body tbody tr').count();
    assert.equal(rows,14+3,'14 種型態＋基準＋POC＋價值區');
    assert((await page.locator('#k-legend-body').innerText()).includes('全部交易日（對照基準）'));

    /* ---- 頭肩底與缺口（HS）：切換股票保留區間與開關 ---- */
    await page.locator('[data-compare-row=HS] button').click();
    assert.equal(await page.locator('#k-range').inputValue(),'250');
    await page.locator('#k-range').selectOption('120');
    o=await option(page);
    assert(o.hs>=1,'頭肩底畫在圖上');assert(o.gaps>=1,'缺口虛線框');
    const hsText=await page.locator('#k-summary').innerText();
    assert(/頭肩底 ✓/.test(hsText)&&hsText.includes('突破頸線'),hsText);
    assert(hsText.includes('區間內尚未回補的缺口 1 個'),hsText);
    await page.locator('.c1').screenshot({path:path.join(output,'kline-head-shoulders.png')});

    /* ---- 重新整理：開關與區間記在瀏覽器 ---- */
    await page.goto(base+'/?code=AAA');
    await page.waitForFunction(()=>/完成 1 \/ 1/.test(document.querySelector('#status').textContent)&&document.querySelector('#k1 canvas'),null,{timeout:60000});
    assert.equal(await page.locator('#k-range').inputValue(),'120');
    assert.equal(await page.locator('#btn-fib').getAttribute('aria-pressed'),'true');
    assert(!(await page.locator('#k-pats input[data-kpat=doji]').isChecked()));
    await page.locator('#k-pats [data-kpat-all="1"]').click();
    assert(await page.locator('#k-pats input[data-kpat=doji]').isChecked());
    await page.locator('#btn-fib').click();

    /* ---- 分析完自動捲到圖表；捲動後出現精簡頁首 ---- */
    await page.waitForFunction(()=>document.getElementById('qnav').classList.contains('show'));
    assert((await page.locator('#qn-cur').innerText()).includes('AAA'));
    await page.locator('#qnav .qn-links [data-qn-go=top]').click();
    await page.waitForFunction(()=>!document.getElementById('qnav').classList.contains('show'));
    await page.locator('#qnav .qn-links [data-qn-go=market]').evaluate(n=>n.click());
    await page.waitForFunction(()=>document.getElementById('market').getBoundingClientRect().top<120);
    await page.locator('#qn-code').fill('BBB');await page.locator('#qn-code').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#h-code').textContent==='BBB',null,{timeout:60000});
    await page.waitForFunction(()=>{const r=document.getElementById('stage').getBoundingClientRect();return r.top<200&&r.bottom>0;});
    await page.screenshot({path:path.join(output,'quicknav.png')});
    /* 全球市場收合 */
    await page.locator('#macro-toggle').click();
    assert(await page.locator('#macro-tiles').isHidden());
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('macro').classList.contains('collapsed'));
    await page.locator('#macro-toggle').click();assert(await page.locator('#macro-tiles').isVisible());

    /* ---- PNG 與離線報告 ---- */
    await page.locator('#f-code').fill('AAA');await page.locator('#btn-go').click();
    await page.waitForFunction(()=>/完成 1 \/ 1/.test(document.querySelector('#status').textContent)&&document.querySelector('#k1 canvas'),null,{timeout:60000});
    let wait=page.waitForEvent('download');await page.locator('.k-png').click();let d=await wait;
    await d.saveAs(path.join(output,'kline.png'));assert(fs.statSync(path.join(output,'kline.png')).size>20000);
    wait=page.waitForEvent('download');await page.locator('#dl-html').click();d=await wait;
    const file=path.join(work,'report.html');await d.saveAs(file);
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.route(/^https?:/,r=>r.abort());
    await offline.goto('file:///'+file.replace(/\\/g,'/'));await offline.waitForTimeout(800);
    assert.equal(await offline.locator('#k-pats input[data-kpat]').count(),14);
    assert.equal(await offline.locator('#k-range').inputValue(),'120');
    o=await option(offline);assert(o.ids.includes('vp')&&o.ids.includes('marks'));
    await offline.locator('#k-range').selectOption('60');o=await option(offline);assert.equal(o.n,60);
    await offline.close();

    /* ---- 手機：不橫向捲動、工具列可換行 ---- */
    await page.setViewportSize({width:390,height:900});await page.waitForTimeout(300);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手機版不該整頁橫向捲動');
    const clipped=await page.locator('.grid .card').evaluateAll(ns=>ns.filter(n=>!n.hidden&&n.scrollHeight>n.clientHeight+3).map(n=>n.className));
    assert.deepStrictEqual(clipped,[]);
    await page.locator('.c1').screenshot({path:path.join(output,'kline-mobile.png')});

    assert.deepStrictEqual(errors,[]);
    console.log('PASS: main chart full width, default 120-day range/overlays, pattern markers + hit-rate tooltip with baseline, per-pattern and master toggles, 250-day range with Fibonacci window, volume profile POC/VAH/VAL (recomputed on zoom), legend table, head-and-shoulders bottom + open gap summary, settings persisted across reload/stocks, quick nav (auto-scroll, jump, quick analyse), macro collapse persisted, PNG, offline report, mobile');
  }finally{
    if(browser)await browser.close();child.kill();
    try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}
  }
})().catch(e=>{console.error(e);process.exit(1);});
