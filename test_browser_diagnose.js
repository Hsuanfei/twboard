/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* 20260925b：證交所／櫃買連不上時，掃描要很快失敗、說出原因，並自動顯示「連線檢查」結果。 */
const { chromium, python, launchOptions } = require('./test_support');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const serverCode = `
import os, ssl, json, socket, tempfile, urllib.error, urllib.parse
os.environ["TWBOARD_DATA_DIR"]=tempfile.mkdtemp(prefix="twboard-diag-")
import twboard as T, twserve as S, twmarket as MK
MK.INTERVAL={}
class Resp:
    status=200
    def __init__(self,b): self.b=b.encode()
    def __enter__(self): return self
    def __exit__(self,*a): return False
    def read(self): return self.b
def urlopen(req, timeout=None, context=None):
    u=req.full_url if hasattr(req,'full_url') else req
    host=urllib.parse.urlsplit(u).netloc
    if 'twse' in host or 'tpex' in host:
        e=ssl.SSLCertVerificationError(1,'certificate verify failed'); e.verify_message='Missing Subject Key Identifier'
        raise urllib.error.URLError(e)
    if 'finmind' in host:
        return Resp(json.dumps({"status":200,"data":[]}))
    raise urllib.error.URLError(socket.gaierror(11001,'getaddrinfo failed'))
T.urllib.request.urlopen=urlopen
server=S.ThreadingHTTPServer(('127.0.0.1',0),S.Handler)
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
    const output=path.join(__dirname,'qa-20260925b');fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch(launchOptions());
    const page=await (await browser.newContext({viewport:{width:1500,height:1000}})).newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+port);
    const t0=Date.now();
    await page.locator('#mk-scan').click();
    await page.waitForFunction(()=>document.querySelector('#mk-prog-stage').textContent.includes('掃描失敗'),null,{timeout:20000});
    assert(Date.now()-t0<15000,'連不上時要很快結束');
    const msg=await page.locator('#mk-note').innerText();
    assert(msg.includes('Missing Subject Key Identifier')&&msg.includes('連線檢查'),msg);
    // 失敗後自動跑連線檢查
    await page.waitForFunction(()=>document.querySelector('#mk-diag').textContent.includes('連線檢查結果'),null,{timeout:20000});
    const diag=await page.locator('#mk-diag').innerText();
    assert(diag.includes('證交所 上市行情')&&diag.includes('✗')&&diag.includes('✓'),'每個來源都有結果');
    assert(diag.includes('可能原因')&&diag.includes('憑證'),'要給出可能原因');
    assert(diag.includes('嚴格模式已關閉')||!diag.includes('嚴格模式'),'顯示 X.509 設定');
    assert.equal(await page.locator('#mk-diag tbody tr').count(),7);
    await page.locator('#market').screenshot({path:path.join(output,'diagnose.png')});
    // 手動再按一次也可以
    await page.locator('#mk-diag-btn').click();
    await page.waitForFunction(()=>document.querySelector('#mk-diag').textContent.includes('連線檢查結果'));
    assert.deepEqual(errors,[]);
    console.log('PASS: failed scan ends fast with the SSL reason, auto connection check (7 sources, ✓/✗, hint, Python/OpenSSL), manual re-check');
  }finally{
    if(browser)await browser.close();
    child.kill();
  }
})().catch(e=>{console.error(e);process.exit(1);});
