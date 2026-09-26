/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 20260925c：進階設定勾選 Yahoo 財經後，日經 225 才會改用 Yahoo；設定記在瀏覽器，「全部清空」會關掉。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const serverCode = `
import datetime as dt, json, tempfile
from pathlib import Path
import twboard as T, twserve as S, twcache as C
C.CACHE_DIR=Path(tempfile.mkdtemp(prefix="twboard-yh-"))
yahoo_hits=[0]
def fake(url, params=None, raw_text=False, **kw):
    if "finmind" in url:
        ds, did = params.get("dataset"), params.get("data_id")
        if did == "^N225":
            return {"status":200,"data":[]}
        d0, d1 = dt.date.fromisoformat(params["start_date"]), dt.date.fromisoformat(params["end_date"])
        days=[d0+dt.timedelta(days=i) for i in range((d1-d0).days+1) if (d0+dt.timedelta(days=i)).weekday()<5]
        if ds=="TaiwanExchangeRate":
            return {"status":200,"data":[{"date":x.isoformat(),"currency":"USD","spot_buy":31.8,"spot_sell":31.9} for x in days]}
        if ds=="TaiwanStockPrice":
            return {"status":200,"data":[{"date":x.isoformat(),"stock_id":did,"close":23000+x.toordinal()%40} for x in days]}
        return {"status":200,"data":[{"date":x.isoformat(),"stock_id":did,"Close":6000+x.toordinal()%30} for x in days]}
    if "stooq" in url:
        return "No data"
    if "yahoo" in url:
        yahoo_hits[0]+=1
        end=dt.date.fromtimestamp(params["period2"])-dt.timedelta(days=2)
        days=[end-dt.timedelta(days=i) for i in range(80,0,-1) if (end-dt.timedelta(days=i)).weekday()<5]
        stamps=[int(dt.datetime(x.year,x.month,x.day,tzinfo=dt.timezone.utc).timestamp()) for x in days]
        return {"chart":{"result":[{"meta":{"gmtoffset":32400},"timestamp":stamps,"indicators":{"quote":[{"close":[39000+i for i in range(len(days))]}]}}],"error":None}}
    return None
T.http_get_json=fake
class H(S.Handler):
    def do_GET(self):
        if self.path=="/test/yahoo":
            return self._json({"ok":True,"hits":yahoo_hits[0]})
        return super().do_GET()
server=S.ThreadingHTTPServer(('127.0.0.1',0),H)
print(server.server_address[1],flush=True)
server.serve_forever()
`;
(async()=>{
  const child=spawn(python,['-B','-c',serverCode],{cwd:__dirname,windowsHide:true});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(Number(text.trim()));});
      child.on('error',reject);child.on('exit',c=>reject(new Error('server exit '+c)));
    });
    const base='http://127.0.0.1:'+port;
    const output=path.join(__dirname,'qa-20260925c');fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1500,height:1000}});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const macroUrls=[];page.on('request',r=>{if(r.url().includes('/api/macro'))macroUrls.push(r.url());});
    const nikkei=()=>page.locator('#macro-tiles .mtile').nth(4).innerText();
    await page.goto(base);
    await page.waitForFunction(()=>document.querySelectorAll('#macro-tiles .mtile').length===5);
    assert((await nikkei()).includes('無資料'),'預設不用 Yahoo，日經維持無資料');
    assert(!macroUrls.some(u=>u.includes('yahoo=1')));
    assert.equal((await (await page.request.get(base+'/test/yahoo')).json()).hits,0,'沒勾選時完全不連 Yahoo');
    assert(!(await page.locator('#a-yahoo').isChecked()));
    // 勾選 → 立即重新讀取
    await page.locator('#adv summary').click();
    await page.locator('#a-yahoo').check();
    await page.waitForFunction(()=>document.querySelectorAll('#macro-tiles .mtile')[4].textContent.includes('Yahoo'));
    const tile=await nikkei();
    assert(tile.includes('Yahoo 財經（非官方）')&&!tile.includes('無資料'),tile);
    assert(macroUrls.some(u=>u.includes('yahoo=1')&&u.includes('refresh=1')));
    await page.locator('#macro').screenshot({path:path.join(output,'macro-yahoo.png')});
    // 重新整理：設定記在這台電腦的瀏覽器
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('#macro-tiles .mtile').length===5&&document.querySelectorAll('#macro-tiles .mtile')[4].textContent.includes('Yahoo'));
    assert(await page.locator('#a-yahoo').isChecked());
    // 全部清空 → 關閉並回到原本來源
    await page.locator('#adv summary').click();
    await page.locator('#a-reset').click();
    await page.waitForFunction(()=>document.querySelectorAll('#macro-tiles .mtile')[4].textContent.includes('無資料'));
    assert(!(await page.locator('#a-yahoo').isChecked()));
    assert.deepEqual(errors,[]);
    console.log('PASS: Yahoo off by default (no requests), opt-in reloads macro with Yahoo-labelled Nikkei, setting persists across reload, reset turns it off');
  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exit(1);});
