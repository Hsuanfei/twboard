/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* ========================================================================
   資料來源與用量（1003a）：畫面右下角的小視窗。
   顯示 FinMind 本小時用了幾次、還剩多少，各資料來源連線是否正常、現在在等誰，以及本機資料庫的使用情形。
   資料來自 /api/usage（只讀本機紀錄，不花 FinMind 額度）。只在互動版載入。
   ======================================================================== */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var box=$('usage');
if(!box) return;

var data=null, timer=null, inflight=false, confirmClear=false, confirmTimer=null, lastFetch=0;
var STATE={ok:'正常',busy:'讀取中',slow:'回應緩慢',limit:'額度用完',blocked:'被拒絕',error:'連線失敗',idle:'未使用',warn:'注意'};

function ok(v){return typeof v==='number'&&isFinite(v);}
function nf(v,d){return ok(v)?v.toLocaleString('zh-TW',{minimumFractionDigits:d||0,maximumFractionDigits:d||0}):'—';}
function esc(s){return String(s===undefined||s===null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
function ago(ts,now){
  if(!ok(ts)) return '';
  var s=Math.max(0,Math.round((now||Date.now()/1000)-ts));
  if(s<5) return '剛剛'; if(s<60) return s+' 秒前'; if(s<3600) return Math.floor(s/60)+' 分鐘前';
  var d=new Date(ts*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
}
function clock(ts){ var d=new Date(ts*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
function bytes(n){ if(!ok(n)) return '—'; return n>=1048576?nf(n/1048576,1)+' MB':n>=1024?nf(n/1024,0)+' KB':nf(n,0)+' B'; }
function secs(v){ return ok(v)?(v<10?nf(v,1):nf(v,0))+' 秒':''; }

function isBusy(){
  var bar=$('pw-bar'), scan=$('mk-scan');
  return document.body.classList.contains('loading') || (bar&&bar.classList.contains('on')) ||
         (scan&&scan.disabled) || !!(data&&data.busy);
}
function src(name){ return data&&data.sources?data.sources.filter(function(s){return s.name===name;})[0]:null; }

/* 錯誤原因 → 白話建議 */
function advice(s){
  var e=String(s.error||'');
  if(s.state==='limit') return '查詢次數已達上限。先等額度恢復（每小時重置），這段時間程式會改用本機資料庫的資料。';
  if(s.state==='blocked') return '對方拒絕查詢（HTTP 403），通常是短時間查太多次，過一陣子再試。';
  if(/SSL|憑證/.test(e)) return '憑證驗證失敗：先確認電腦日期時間正確；公司防火牆或防毒軟體若會檢查 SSL，需要把這個網站設為例外。';
  if(/DNS|找不到主機/.test(e)) return '找不到主機：網路可能斷線，或 DNS 有問題。';
  if(/逾時/.test(e)) return '連線逾時：網路較慢或網站忙碌，稍後會自動重試。';
  if(/代理/.test(e)) return '代理伺服器設定有問題。';
  if(/拒絕|中斷/.test(e)) return '連線被擋下或中斷：可能是防火牆、防毒軟體，或網站暫時限制。';
  return '';
}

/* 小視窗外面那顆按鈕：一眼看出最重要的狀態。
   順序：額度用完 → 正在等很久 → 主要來源（FinMind、證交所、櫃買、集保）連線失敗 → 讀取中 → 備援來源（Stooq、Yahoo）失敗 → 額度快用完 → 正常 */
var BACKUP=['Stooq','Yahoo 財經'];
function summary(){
  var fm=data.finmind, now=data.now, list=data.sources||[];
  var recentFail=function(s){ return (s.state==='error'||s.state==='blocked')&&now-(s.last_fail||0)<600; };
  var waiting=[]; list.forEach(function(s){ (s.inflight||[]).forEach(function(i){ waiting.push({src:s.name,what:i.what,seconds:i.seconds}); }); });
  waiting.sort(function(a,b){return b.seconds-a.seconds;});
  var fmText='FinMind <b>'+nf(fm.used)+'</b> / '+nf(fm.limit);
  var limit=list.filter(function(s){return s.state==='limit';})[0];
  if(limit) return {cls:'limit',html:esc(limit.name)+' 額度用完 · 本小時 <b>'+nf(fm.used)+'</b> / '+nf(fm.limit),plain:limit.name+' 查詢次數已達上限'};
  var slow=waiting.filter(function(w){return w.seconds>=8;})[0];
  if(slow) return {cls:'slow',html:'等待 '+esc(slow.src)+' 回應 '+secs(slow.seconds),plain:'等待 '+slow.src+' 回應中'};
  var bad=list.filter(function(s){return recentFail(s)&&BACKUP.indexOf(s.name)<0;})[0];
  if(bad) return {cls:bad.state,html:esc(bad.name)+' '+STATE[bad.state]+' · '+fmText,plain:bad.name+' '+STATE[bad.state]};
  if(waiting.length) return {cls:'busy',html:'讀取中 · '+fmText,plain:'讀取中'};
  var backup=list.filter(function(s){return recentFail(s)&&BACKUP.indexOf(s.name)>=0;})[0];
  if(backup) return {cls:'warn',html:esc(backup.name)+' '+STATE[backup.state]+' · '+fmText,plain:backup.name+' '+STATE[backup.state]+'（備援來源）'};
  if(fm.limit&&fm.remaining/fm.limit<0.15) return {cls:'warn',html:fmText+' · 剩 '+nf(fm.remaining),plain:'FinMind 額度快用完'};
  var any=list.some(function(s){return s.state==='ok';});
  return {cls:any?'ok':'idle',html:fmText+' · 剩 '+nf(fm.remaining),plain:any?'連線正常':'尚未連線'};
}

function renderFinMind(){
  var fm=data.finmind, now=data.now, pct=ok(fm.pct)?fm.pct:0;
  var cls=fm.remaining<=0||fm.quota_at?'crit':pct>=85?'warn':'';
  var h='<div class="us-big"><span>FinMind 本小時</span><b>'+nf(fm.used)+'</b><span>/ '+nf(fm.limit)+' 次</span>'+
    '<em class="'+(cls==='crit'?'down':cls==='warn'?'':'up')+'" style="color:'+(cls==='crit'?'#ff8a8d':cls==='warn'?'#f6c453':'#5fd896')+'">剩 '+nf(fm.remaining)+' 次</em></div>'+
    '<div class="us-bar" role="progressbar" aria-valuemin="0" aria-valuemax="'+fm.limit+'" aria-valuenow="'+fm.used+'" aria-label="FinMind 本小時用量"><i class="'+cls+'" style="width:'+Math.min(100,pct)+'%"></i></div>';
  if(fm.basis==='official'){
    h+='<p class="us-note">FinMind 官方數字（'+ago(fm.official_at,now)+'更新），包含這台電腦以外用同一個 Token 的查詢。本程式近 60 分鐘送出 '+nf(fm.local_used)+' 次。</p>';
  }else{
    h+='<p class="us-note">本程式近 60 分鐘送出的查詢次數'+(fm.token?'（已填 Token，免費會員 600 次／小時；'+(fm.official_error?'官方用量暫時查不到：'+esc(fm.official_error):'官方用量讀取中')+'）':'（未填 Token：匿名額度 300 次／小時，同一個網路的其他程式也算在內）')+
      (fm.first_in_window?'。最早一筆在 '+clock(fm.first_in_window+3600)+' 滿一小時。':'。')+'</p>';
  }
  if(fm.quota_at){
    h+='<div class="us-alert crit">'+clock(fm.quota_at)+' FinMind 回覆「查詢次數已達上限」。先等額度恢復（每小時重置），這段時間程式會改用本機資料庫的資料，新資料可能晚一點才出現。'+
       (fm.token?'':'<br>到「進階」填入免費註冊的 FinMind Token，額度可提高到 600 次／小時。')+'</div>';
  }else if(cls==='warn'){
    h+='<div class="us-alert warn">本小時額度已用 '+nf(pct,0)+'%。大量分析（市場掃描、一次十檔）前，建議等一下或改天再做。</div>';
  }else if(!fm.token && data.demo!==true){
    h+='<div class="us-alert tip">到「進階」填入 FinMind Token（免費註冊）：額度從 300 提高到 600 次／小時，這裡也會顯示官方的用量數字。</div>';
  }
  if(data.demo) h+='<p class="us-note">目前是示範模式（合成資料），不會連網。</p>';
  $('us-fm').innerHTML=h;
}

function renderSources(){
  var now=data.now, waiting=[];
  $('us-src').innerHTML=data.sources.map(function(s){
    (s.inflight||[]).forEach(function(i){ waiting.push({src:s.name,what:i.what,seconds:i.seconds}); });
    var parts=[];
    if(s.state==='busy'||s.state==='slow'){
      var w=s.inflight[0]; parts.push('正在查 '+esc(w.what)+'，已等 '+secs(w.seconds));
    }
    if(s.last_ok) parts.push(ago(s.last_ok,now)+'成功');
    if(s.last_fail&&(s.state==='error'||s.state==='blocked'||s.state==='limit')){
      parts.push(ago(s.last_fail,now)+'失敗：'+esc(s.error||'')+(s.streak>1?'（連續 '+s.streak+' 次）':''));
    }
    if(ok(s.avg_ms)) parts.push('平均 '+(s.avg_ms<1000?nf(s.avg_ms)+' 毫秒':nf(s.avg_ms/1000,1)+' 秒'));
    if(ok(s.hour)) parts.push('近 60 分鐘 '+nf(s.hour)+' 次');
    if(s.state==='idle'&&!parts.length) parts.push('這次開啟後還沒用到');
    var tip=(s.state==='error'||s.state==='blocked'||s.state==='limit')?advice(s):'';
    return '<li data-us-src="'+esc(s.name)+'"><i class="us-dot '+s.state+'"></i><span class="us-name">'+esc(s.name)+'</span>'+
      '<span class="us-st"><b class="'+s.state+'">'+STATE[s.state]+'</b></span>'+
      '<small>'+parts.join(' · ')+(tip?'<br>'+esc(tip):'')+'</small></li>';
  }).join('');
  waiting.sort(function(a,b){return b.seconds-a.seconds;});
  $('us-now-box').hidden=!waiting.length;
  $('us-now').innerHTML=waiting.map(function(w){
    return '<li class="'+(w.seconds>=8?'slow':'')+'"><span>'+esc(w.src)+' · '+esc(w.what)+'</span><span>'+secs(w.seconds)+'</span></li>';
  }).join('');
}

function renderCache(){
  var c=data.cache||{};
  var h='<p class="us-note"><b>'+bytes(c.bytes)+'</b> · <b>'+nf(c.rows)+'</b> 筆（'+nf(c.datasets)+' 份資料），存在程式資料夾的 .twboard-cache。</p>';
  var total=(c.hits_hour||0)+(c.net_hour||0);
  h+=total?'<p class="us-note">近 60 分鐘讀取資料 <b>'+nf(total)+'</b> 次：<b>'+nf(c.hits_hour)+'</b> 次直接用本機資料庫、'+nf(c.net_hour)+' 次需要連網'+
     (ok(c.saved_pct)&&c.saved_pct>0?'（省下 <b>'+nf(c.saved_pct)+'%</b> 的查詢）':'')+'。</p>':
     '<p class="us-note">近 60 分鐘還沒有讀取資料。</p>';
  h+='<details class="us-rules"><summary>資料多久重新確認一次？</summary><ul>'+(c.rules||[]).map(function(r){return '<li>'+esc(r)+'</li>';}).join('')+
     '<li>按強力分析的「↻ 重抓」會忽略以上規則，立刻重新確認近幾天的資料。</li></ul></details>';
  $('us-cache').innerHTML=h;
}

function render(){
  if(!data) return;
  var s=summary();
  $('us-dot').className='us-dot '+s.cls;
  $('us-pill-text').innerHTML=s.html;
  $('us-pill').setAttribute('aria-label','資料來源與用量：'+s.plain+'，FinMind 本小時 '+data.finmind.used+' / '+data.finmind.limit+' 次');
  var pw=$('pw-usage');
  if(pw) pw.innerHTML='<i class="us-dot '+s.cls+'"></i>'+s.html;
  if($('us-panel').hidden) return;
  $('us-updated').textContent='更新於 '+ago(data.now);
  renderFinMind(); renderSources(); renderCache();
}

async function poll(){
  if(inflight) return;
  inflight=true; lastFetch=Date.now();
  try{
    var r=await fetch('/api/usage'); var j=await r.json();
    if(r.ok&&j.ok){ data=j.data; render(); }
  }catch(e){
    $('us-dot').className='us-dot error';
    $('us-pill-text').textContent='程式沒有回應（黑色視窗被關掉了？）';
  }finally{ inflight=false; schedule(); }
}
function delay(){
  if(document.hidden) return 30000;
  if(isBusy()) return 1500;
  if(!$('us-panel').hidden) return 4000;
  return 15000;
}
function schedule(ms){
  clearTimeout(timer);
  timer=setTimeout(poll, ms===undefined?delay():ms);
}
function poke(){ if(Date.now()-lastFetch>700) schedule(150); }

function setOpen(open){
  $('us-panel').hidden=!open;
  $('us-pill').setAttribute('aria-expanded',String(open));
  try{ localStorage.setItem('twboard.usage.open',open?'1':'0'); }catch(e){}
  if(open){ render(); poke(); }
}
$('us-pill').addEventListener('click',function(){ setOpen($('us-panel').hidden); });
$('us-close').addEventListener('click',function(){ setOpen(false); $('us-pill').focus(); });
$('us-refresh').addEventListener('click',function(){ schedule(0); });
box.addEventListener('keydown',function(e){ if(e.key==='Escape'&&!$('us-panel').hidden){ setOpen(false); $('us-pill').focus(); } });
$('us-diagnose').addEventListener('click',function(){
  var b=$('mk-diag-btn');
  if(b){ b.click(); var t=$('mk-diag')||$('market'); setTimeout(function(){ if(t) t.scrollIntoView({behavior:'smooth',block:'start'}); },150); }
  setTimeout(poke,1200);
});
$('us-clear').addEventListener('click',async function(){
  var btn=$('us-clear'), msg=$('us-msg');
  if(!confirmClear){
    confirmClear=true; btn.textContent='確定清除？再按一次';
    msg.textContent='清除後會重新下載資料，會用到 FinMind 額度（10 年日K 每檔約 1 次查詢）。';
    clearTimeout(confirmTimer); confirmTimer=setTimeout(function(){ confirmClear=false; btn.textContent='清除本機資料庫…'; msg.textContent=''; },6000);
    return;
  }
  clearTimeout(confirmTimer); confirmClear=false; btn.disabled=true; btn.textContent='清除中…';
  try{
    var r=await fetch('/api/cache/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'yes'})});
    var j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||'清除失敗');
    msg.textContent='已清除 '+nf(j.data.removed)+' 筆資料。';
  }catch(e){ msg.textContent=e.message; }
  finally{ btn.disabled=false; btn.textContent='清除本機資料庫…'; poke(); }
});
document.addEventListener('visibilitychange',function(){ if(!document.hidden) poke(); });
/* 開始分析、強力分析讀取、市場掃描時立刻更新，讀取期間每 1.5 秒更新一次 */
var mo=new MutationObserver(function(){ if(isBusy()) poke(); });
mo.observe(document.body,{attributes:true,attributeFilter:['class']});
if($('pw-bar')) mo.observe($('pw-bar'),{attributes:true,attributeFilter:['class']});
if($('mk-scan')) mo.observe($('mk-scan'),{attributes:true,attributeFilter:['disabled']});

try{ if(localStorage.getItem('twboard.usage.open')==='1') setOpen(true); }catch(e){}
poll();
window.TWUsage={poll:poll,poke:poke,data:function(){return data;},open:setOpen};
})();
