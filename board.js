/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* ========================================================================
   payload 由 twboard.py 注入
   ======================================================================== */
(function(){
"use strict";
var P = null;
var activeView = 'all';
var strategyChart=null, strategyResult=null;
var css = function(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
var charts = [];
var macroCharts = [], latestMacroData=null;
var C = {};
var fontScale=1, zoomed=null, zoomMarker=null, zoomFocus=null;
function scaleChartFonts(opt){
  if(opt.legend&&!Array.isArray(opt.legend))opt.legend.type='scroll';
  var visited=new WeakSet();
  function visit(value){
    if(!value||typeof value!=='object'||visited.has(value)) return;
    visited.add(value);
    Object.keys(value).forEach(function(k){
      if(k==='data') return;
      if(['textStyle','axisLabel','axisName','label'].indexOf(k)>=0&&value[k]&&typeof value[k]==='object'&&value[k].fontSize===undefined&&value[k].font===undefined)value[k].fontSize=12;
      if(k==='fontSize'&&typeof value[k]==='number') value[k]*=fontScale;
      else if(k==='font'&&typeof value[k]==='string') value[k]=value[k].replace(/([0-9.]+)px/g,function(_,n){return Number(n)*fontScale+'px';});
      else visit(value[k]);
    });
  }
  visit(opt);return opt;
}
function resizeCharts(){
  /* 主K線圖的籌碼分佈寬度依圖寬計算：寬度變化超過 15%（例如手機轉向、視窗縮放）就整張重畫 */
  var k=el('k1'), kc=k&&echarts.getInstanceByDom(k);
  if(kc&&k1Width&&Math.abs((k.clientWidth||0)-k1Width)>k1Width*0.15){ redrawK1(); }
  charts.forEach(function(c){c.resize();});macroCharts.forEach(function(c){c.resize();});if(strategyChart)strategyChart.resize();
}
var k1Width=0;
function closeZoom(){
  if(!zoomed)return;
  var node=zoomed,focus=zoomFocus;zoomed=null;
  if(zoomMarker&&zoomMarker.parentNode)zoomMarker.replaceWith(node);
  zoomMarker=null;zoomFocus=null;
  document.documentElement.style.overflow='';
  if(el('chart-dialog').open)el('chart-dialog').close();
  resizeCharts();
  if(focus&&focus.isConnected)focus.focus({preventScroll:true});
}
function openZoom(node,focus){
  if(!node||(!P&&!node.matches('.macro-chart')))return;
  if(zoomed){closeZoom();return;}
  zoomed=node;zoomFocus=focus||node.querySelector('.chart-expand')||node;
  zoomMarker=document.createComment('chart-original-position');node.before(zoomMarker);
  var heading=node.querySelector('h3,.mc-title');
  if(heading){heading=heading.cloneNode(true);heading.querySelectorAll('button,.sub').forEach(function(n){n.remove();});}
  el('zoom-title').textContent=(node.matches('.macro-chart')?'全球市場':P.code+' '+P.name)+' · '+(heading?heading.textContent.replace(/[↓⤢]/g,'').trim():'策略淨值圖');
  el('zoom-host').appendChild(node);el('chart-dialog').showModal();
  document.documentElement.style.overflow='hidden';resizeCharts();
}
function setFontSize(value,persist){
  value=String(value);fontScale=['1','1.15','1.3'].indexOf(value)>=0?Number(value):1;
  document.documentElement.style.setProperty('--font-scale',fontScale);
  document.documentElement.toggleAttribute('data-large-font',fontScale>1);
  el('font-size').value=String(fontScale);
  if(persist){try{localStorage.setItem('twboard-font-size',String(fontScale));}catch(e){}}
  if(P)drawAll();
  if(latestMacroData)renderMacro(latestMacroData);
}
function bindAppearance(){
  document.body.appendChild(el('chart-dialog'));
  var saved='1';try{saved=localStorage.getItem('twboard-font-size')||'1';}catch(e){}
  setFontSize(saved,false);
  el('font-size').addEventListener('change',function(){setFontSize(this.value,true);});
  document.querySelectorAll('.card h3,.dmi-panel h3,.macro-chart .mc-title').forEach(function(h){
    var b=document.createElement('button');b.type='button';b.className='chart-expand';b.textContent='⤢';
    b.setAttribute('aria-label','放大 '+h.textContent.replace(/↓/g,'').trim());b.title='放大圖卡';h.appendChild(b);
  });
  el('strategy-chart').tabIndex=0;el('strategy-chart').setAttribute('aria-label','策略淨值圖，按 Enter 放大');
  var press=null,moved=false;
  document.addEventListener('pointerdown',function(e){press={x:e.clientX,y:e.clientY};moved=false;},true);
  document.addEventListener('pointermove',function(e){if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>8)moved=true;},true);
  document.addEventListener('pointercancel',function(){moved=true;press=null;},true);
  document.addEventListener('click',function(e){
    if(moved&&e.detail!==0)return;
    var b=e.target.closest('.chart-expand');
    if(b){openZoom(b.closest('.card,.dmi-panel,.macro-chart'),b);return;}
    if(e.target.closest('button,a,input,select,label,summary,.no-zoom'))return;
    if(window.getSelection()&&!window.getSelection().isCollapsed)return;
    var node=e.target.closest('.card,#strategy-chart,.dmi-panel,.macro-chart');
    if(node){if(zoomed===node)closeZoom();else openZoom(node);}
    else if(e.target===el('chart-dialog'))closeZoom();
  });
  el('strategy-chart').addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openZoom(this,this);}});
  el('zoom-close').addEventListener('click',closeZoom);
  el('chart-dialog').addEventListener('cancel',function(e){e.preventDefault();closeZoom();});
  el('chart-dialog').addEventListener('close',function(){if(!this.open)closeZoom();});
  window.addEventListener('beforeprint',closeZoom);
}


function readColors(){
  C = {
    up:css('--up'), down:css('--down'),
    s1:css('--s1'), s2:css('--s2'), s3:css('--s3'),
    ink:css('--ink'), ink2:css('--ink-2'), muted:css('--muted'),
    grid:css('--grid'), axis:css('--axis'), surface:css('--surface'),
    good:css('--good'), warn:css('--warn'), serious:css('--serious'), crit:css('--crit'),
    seq:[css('--seq-0'),css('--seq-1'),css('--seq-2'),css('--seq-3'),css('--seq-4'),css('--seq-5'),css('--seq-6')]
  };
}

/* ---------- 格式化 ---------- */
function nf(v,d){ if(v===null||v===undefined||(typeof v==='number'&&!isFinite(v))) return '—';
  return Number(v).toLocaleString('zh-TW',{minimumFractionDigits:d===undefined?2:d,maximumFractionDigits:d===undefined?2:d}); }
function ni(v){ return (v===null||v===undefined)?'—':Number(v).toLocaleString('zh-TW'); }
function sg(v,d){ if(v===null||v===undefined) return '—'; return (v>0?'+':'')+nf(v,d); }
function cls(v){ return v===null||v===undefined?'flat':(v>0?'up':(v<0?'down':'flat')); }
function arrow(v){ return v===null||v===undefined?'':(v>0?'▲':(v<0?'▼':'')); }
function el(id){ return document.getElementById(id); }
function txt(id,s,k){ var e=el(id); if(!e) return; e.textContent=s; if(k) e.className='vl '+k; }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }

/* ---------- 空狀態 ---------- */
function emptyCard(node, msg, sub){
  node.removeAttribute('style');
  node.className='empty';
  node.innerHTML = '<div class="ei">◌</div><div>'+esc(msg)+'</div>'+
                   (sub?'<div style="font-size:calc(11px * var(--font-scale, 1));opacity:.75">'+esc(sub)+'</div>':'');
}

/* ---------- ECharts 共用 ---------- */
function base(){
  return {
    backgroundColor:'transparent',
    animation:false,
    textStyle:{fontFamily:'system-ui,-apple-system,"Segoe UI","Microsoft JhengHei","PingFang TC",sans-serif',
               color:C.ink2, fontSize:11},
    tooltip:{
      backgroundColor:'rgba(16,20,28,.96)', borderColor:'rgba(255,255,255,.14)', borderWidth:1,
      textStyle:{color:'#fff',fontSize:11.5}, padding:[7,10], confine:true,
      axisPointer:{lineStyle:{color:C.axis,width:1}, crossStyle:{color:C.axis,width:1},
                   label:{backgroundColor:'#2a3243',color:'#fff'}}
    }
  };
}
function ax(extra){
  return Object.assign({
    axisLine:{lineStyle:{color:C.axis}},
    axisTick:{show:false},
    axisLabel:{color:C.muted,fontSize:10},
    splitLine:{show:true,lineStyle:{color:C.grid,type:'solid'}}
  }, extra||{});
}
function mk(id, opt){
  var node = el(id); if(!node || node.closest('[hidden]')) return null;
  var ch = echarts.init(node, null, {renderer:'canvas'});
  ch.setOption(scaleChartFonts(opt));
  charts.push(ch);
  return ch;
}

/* ========================================================================
   01 主K線圖（0928a）：可切換區間、K 線型態標註與歷史勝率、跳空缺口、頭肩型態、
   籌碼成本分佈（POC／價值區），以及原本的均線、布林通道、費波南希、支撐壓力。
   開關與區間記在這台電腦的瀏覽器；離線匯出的報告也能用。
   ======================================================================== */
var K1 = {range:null, bb:false, fib:false, sr:true, vp:true, pat:true, off:{}, legend:null};
(function(){
  try{
    var o=JSON.parse(localStorage.getItem('twboard.k1')||'{}');
    if(o&&typeof o==='object'){
      ['bb','fib','sr','vp','pat'].forEach(function(k){ if(typeof o[k]==='boolean') K1[k]=o[k]; });
      if(typeof o.range==='number') K1.range=o.range;
      if(o.off&&typeof o.off==='object') K1.off=o.off;
      if(o.legend&&typeof o.legend==='object') K1.legend=o.legend;
    }
  }catch(e){}
})();
function saveK1(){ try{ localStorage.setItem('twboard.k1',JSON.stringify(K1)); }catch(e){} }
var KFIELDS=['date','open','high','low','close','vol','ma5','ma10','ma20','ma60','bb_upper','bb_mid','bb_lower','bb_percent_b','bb_width'];
var KSTD=[60,120,250];
function kWindow(){ return P.kline ? P.kline.window : P.series.date.length; }
function kRanges(){ return (P.kline&&P.kline.ranges&&P.kline.ranges.length) ? P.kline.ranges : [P.series.date.length]; }
function kRange(){
  var opts=kRanges(), W=kWindow(), want=K1.range, fit;
  if(want===0 && opts.indexOf(W)>=0) return W;
  if(want && opts.indexOf(want)>=0) return want;
  if(want){ fit=opts.filter(function(r){return r<=want;}); if(fit.length) return fit[fit.length-1]; }
  var def=Math.max(120,W);
  fit=opts.filter(function(r){return r<=def;});
  return fit.length ? fit[fit.length-1] : opts[0];
}
function kview(){
  var k=P.kline;
  if(!k||!k.date||!k.date.length) return {s:P.series, fib:P.fibonacci, off:0, r:P.series.date.length, n:P.series.date.length};
  var r=kRange(), n=k.date.length, off=n-r, s={};
  KFIELDS.forEach(function(f){ s[f]=(k[f]||[]).slice(off); });
  var fib=(k.fib&&k.fib[String(r)]) || (r===k.window ? P.fibonacci : null);
  return {s:s, fib:fib, off:off, r:r, n:n};
}
function alpha(color, a){
  var m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color||'').trim());
  if(!m) return color;
  var h=m[1].length===3 ? m[1].replace(/./g,function(c){return c+c;}) : m[1];
  return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+a+')';
}
function patDefs(){ var m={}; ((P.patterns&&P.patterns.defs)||[]).forEach(function(d){m[d.key]=d;}); return m; }
function dirColor(dir){ return dir==='bull'?C.up:dir==='bear'?C.down:C.warn; }
function dirGlyph(dir){ return dir==='bull'?'▲':dir==='bear'?'▼':'◆'; }
function patShown(key){ return K1.pat && !K1.off[key]; }

/* 籌碼成本分佈：把每天的成交量平均攤到當天最低～最高價之間（估計值，不是逐筆成交） */
function volumeProfile(s, a, b, bins){
  var lo=Infinity, hi=-Infinity, i;
  for(i=a;i<=b;i++){ if(s.low[i]!=null&&s.low[i]<lo) lo=s.low[i]; if(s.high[i]!=null&&s.high[i]>hi) hi=s.high[i]; }
  if(!(hi>lo)) return null;
  var step=(hi-lo)/bins, up=[], dn=[];
  for(i=0;i<bins;i++){ up.push(0); dn.push(0); }
  for(i=a;i<=b;i++){
    var l=s.low[i], h=s.high[i], v=s.vol[i];
    if(l==null||h==null||!v) continue;
    var bag=(s.close[i]>=s.open[i]) ? up : dn;
    if(h<=l){ bag[Math.min(bins-1,Math.max(0,Math.floor((s.close[i]-lo)/step)))]+=v; continue; }
    var b0=Math.max(0,Math.floor((l-lo)/step)), b1=Math.min(bins-1,Math.floor((h-lo)/step));
    for(var k=b0;k<=b1;k++){
      var ov=Math.min(h,lo+(k+1)*step)-Math.max(l,lo+k*step);
      if(ov>0) bag[k]+=v*ov/(h-l);
    }
  }
  var tot=[], total=0, poc=0;
  for(i=0;i<bins;i++){ tot.push(up[i]+dn[i]); total+=tot[i]; if(tot[i]>tot[poc]) poc=i; }
  if(!total) return null;
  var lo_b=poc, hi_b=poc, acc=tot[poc];
  while(acc<total*0.7 && (lo_b>0||hi_b<bins-1)){
    var above=hi_b<bins-1?tot[hi_b+1]:-1, below=lo_b>0?tot[lo_b-1]:-1;
    if(above>=below){ hi_b++; acc+=above; } else { lo_b--; acc+=below; }
  }
  return {lo:lo, step:step, up:up, dn:dn, tot:tot, bins:bins, poc_bin:poc, lo_bin:lo_b, hi_bin:hi_b,
          poc:lo+(poc+0.5)*step, vah:lo+(hi_b+1)*step, val:lo+lo_b*step, max:tot[poc], total:total};
}
function vpSeriesParts(vp){
  if(!vp) return {data:[],line:[],area:[],candleLine:[],candleArea:[],xmax:1};
  var data=[];
  for(var i=0;i<vp.bins;i++){
    data.push([vp.lo+i*vp.step, vp.lo+(i+1)*vp.step, vp.up[i], vp.dn[i], i===vp.poc_bin?1:0, (i>=vp.lo_bin&&i<=vp.hi_bin)?1:0]);
  }
  var lab=function(text,color,pos){return {show:true,position:pos,formatter:text,color:color,fontWeight:'bold',fontSize:11*fontScale,
    backgroundColor:'rgba(12,16,24,.72)',padding:[1,4],borderRadius:3};};
  return {
    data:data, xmax:vp.max*1.1,
    line:[{yAxis:vp.vah,name:'VAH',lineStyle:{color:C.up,type:'dotted',opacity:.55},label:lab('壓力帶 VAH '+nf(vp.vah),C.up,'insideEndTop')},
          {yAxis:vp.poc,name:'POC',lineStyle:{color:C.warn,type:'dashed',width:1.4},label:lab('POC '+nf(vp.poc),C.warn,'insideEndTop')},
          {yAxis:vp.val,name:'VAL',lineStyle:{color:C.down,type:'dotted',opacity:.55},label:lab('支撐帶 VAL '+nf(vp.val),C.down,'insideEndBottom')}],
    area:[[{yAxis:vp.val,itemStyle:{color:'rgba(96,140,255,.08)'}},{yAxis:vp.vah}]],
    candleLine:[{name:'POC',yAxis:vp.poc,vp:true,lineStyle:{color:C.warn,type:'dashed',width:1.3,opacity:.9},label:{show:false}}],
    candleArea:[[{yAxis:vp.val,itemStyle:{color:'rgba(96,140,255,.075)'}},{yAxis:vp.vah}]]
  };
}
function spanLabel(){ return (P.patterns&&P.patterns.span&&P.patterns.span.label)||'歷史'; }
function statLine(st, h){
  h=h||5;
  if(!st||!st['n'+h]) return '歷史上沒有可統計的樣本';
  return h+' 日上漲機率 '+nf(st['up'+h],0)+'%（'+spanLabel()+' n='+st['n'+h]+'，平均 '+sg(st['avg'+h])+'%）';
}

function card01(){
  var v=kview(), s=v.s, t=P.tech, R=s.date.length;
  var kd = s.date.map(function(_,i){ return [s.open[i],s.close[i],s.low[i],s.high[i]]; });
  var vols = s.vol.map(function(x,i){ return {value:x, itemStyle:{color: s.close[i]>=s.open[i]?C.up:C.down, opacity:.62}}; });
  el('t1sub').textContent = 'MA5 '+nf(t.ma5)+'　MA20 '+nf(t.ma20)+'　MA60 '+nf(t.ma60);
  var line=function(name,data,color,w){ return {name:name,type:'line',data:data,smooth:false,symbol:'none',
      lineStyle:{width:w||1.6,color:color}, z:3, connectNulls:false, xAxisIndex:0, yAxisIndex:0}; };
  var DEF=patDefs(), pat=P.patterns||null;
  /* 均線顏色避開紅／綠（漲跌色）；色盲友善配色時再避開橘／藍 */
  var MAC=document.documentElement.getAttribute('data-cb')==='1'?['#f5e663','#9be3c3','#c38bff','#d9d9d9']:['#f2b134','#7fd0a8','#b196ff','#5aa9e6'];

  /* Y 軸範圍：K 棒、均線（MA60 離太遠時不撐開）、布林、支撐壓力 */
  var dLo = Math.min.apply(null, s.low.filter(function(x){return x!=null;})), dHi = Math.max.apply(null, s.high.filter(function(x){return x!=null;}));
  (function(){
    var baseSpan = (dHi - dLo) || 1;
    ['ma5','ma10','ma20','ma60'].forEach(function(k){
      var vals = (s[k]||[]).filter(function(x){ return x!==null && x!==undefined; });
      if(!vals.length) return;
      var lo = Math.min(dLo, Math.min.apply(null, vals)), hi = Math.max(dHi, Math.max.apply(null, vals));
      if(k !== 'ma60' || (hi - lo) <= baseSpan * 1.5){ dLo = lo; dHi = hi; }
    });
  })();
  if(K1.bb && s.bb_upper){
    var bounds=s.bb_upper.concat(s.bb_lower).filter(function(x){return x!==null&&x!==undefined;});
    if(bounds.length){dLo=Math.min(dLo,Math.min.apply(null,bounds));dHi=Math.max(dHi,Math.max.apply(null,bounds));}
  }
  var span = (dHi - dLo) || 1;
  var mlines = [], offnote = [];
  function wantLine(name, val, color, pos){
    if(val===null||val===undefined) return;
    var lo = Math.min(dLo, val), hi = Math.max(dHi, val);
    if((hi - lo) <= span * 1.6){
      mlines.push({name:name, yAxis:val, lineStyle:{color:color,opacity:.7}, label:{position:pos}});
      dLo = lo; dHi = hi;
    }else{
      offnote.push(name+' '+nf(val,2)+'（超出畫面範圍）');
    }
  }
  if(K1.sr){
    wantLine('60日壓力', t.resistance, C.up, 'insideEndTop');
    wantLine('60日支撐', t.support, C.s1, 'insideEndBottom');
    wantLine('20日成交均價', t.vwap20, '#b4a0e8', 'insideStartTop');
  }
  /* 費波南希：波段取自目前的區間，各價位一定在畫面內；38.2%～61.8% 鋪淡色帶 */
  var fib = v.fib, areas = [], fibLines = [];
  if(K1.fib && fib && fib.available){
    fib.levels.forEach(function(lv){
      var edge = lv.ratio===0 || lv.ratio===1;
      var item={name:lv.label, yAxis:lv.price, fibRatio:lv.ratio,
                lineStyle:{color:'#4fd1c5',type:edge?'solid':'dashed',width:1,opacity:edge?.45:.8},
                label:{show:false,position:'insideStartBottom',color:'#8fe3da',fontSize:9}};
      mlines.push(item); fibLines.push(item);
    });
    var z1=fib.levels.filter(function(lv){return lv.ratio===0.382;})[0], z2=fib.levels.filter(function(lv){return lv.ratio===0.618;})[0];
    if(z1&&z2) areas.push([{yAxis:z1.price,fib:true,itemStyle:{color:'rgba(79,209,197,.07)'}},{yAxis:z2.price}]);
  }
  var fi=el('fib-info');
  if(fi){
    fi.hidden=!K1.fib;
    fi.removeAttribute('title');
    if(!fib || !fib.available){
      fi.textContent='費波南希回撤：'+((fib&&fib.reason)||'資料不足');
    }else{
      fi.title=fib.levels.map(function(lv){return lv.label+'：'+nf(lv.price);}).join('　');
      var upw=fib.direction==='up', a=upw?fib.low:fib.high, z=upw?fib.high:fib.low;
      var where=fib.at?('正好在 '+fib.at.label+'（'+nf(fib.at.price)+'）附近')
        :((fib.above?'上方 '+fib.above.label+' '+nf(fib.above.price)+'（'+sg(fib.above.distance_pct)+'%）':'上方已無價位')+' · '+
          (fib.below?'下方 '+fib.below.label+' '+nf(fib.below.price)+'（'+sg(fib.below.distance_pct)+'%）':'下方已無價位'));
      fi.textContent='費波南希回撤（'+fib.window_days+' 日視窗）：'+(upw?'上升波段 ':'下跌波段 ')+
        a.date.slice(5)+' '+(upw?'低 ':'高 ')+nf(a.price)+' → '+z.date.slice(5)+' '+(upw?'高 ':'低 ')+nf(z.price)+
        ' ｜ '+(fib.extending?'今天仍在創波段'+(upw?'新高':'新低')+'，尚未'+(upw?'回撤':'反彈')
               :'收盤 '+nf(fib.close)+' 已'+(upw?'回撤 ':'反彈 ')+nf(fib.retraced_pct,1)+'%')+' ｜ '+where;
    }
  }
  /* 除權息日：垂直虛線（價格未還原，當天的缺口會反映在均線與 KD 上） */
  var divs = (P.dividends && P.dividends.recent) || [];
  divs.forEach(function(ev){
    if(s.date.indexOf(ev.date)<0) return;
    mlines.push({name:ev.kind+(ev.amount!==null&&ev.amount!==undefined?' '+nf(ev.amount,2):''), xAxis:ev.date,
                 lineStyle:{color:C.warn,type:'dotted',opacity:.9}, label:{position:'insideEndTop',color:C.warn}});
  });
  if(divs.length){
    offnote.push('近 60 日有除權息（'+divs.map(function(ev){return ev.date.slice(5)+' '+ev.kind;}).join('、')+
      '）：股價未還原，均線、KD、MA60 與 60 日支撐壓力含除權息缺口');
  }
  if(!P.dividends || !P.dividends.available){
    offnote.push(P.dividends&&P.dividends.status==='partial'?'除權息資料未完整更新，標記可能不齊全':'除權息資料未取得，不能確認是否有事件');
  }
  var b=P.bollinger;
  el('bb-info').hidden=!K1.bb;
  el('bb-info').textContent=b?'布林通道 上 '+nf(b.upper)+' · 中 '+nf(b.mid)+' · 下 '+nf(b.lower)+
    ' ｜ %B '+nf(b.percent_b,3)+' · 寬度 '+nf(b.width)+'% · 寬度百分位 '+nf(b.width_rank,1)+
    (b.squeeze===true?' · 收斂':b.squeeze===null?' · 收斂判斷需139日歷史':'')+
    (b.break_up?' · 今日突破上軌':b.break_down?' · 今日跌破下軌':''):'布林資料不足';
  var bands=[];
  if(K1.bb && s.bb_upper){
    var polygons=[];
    for(var bi=1;bi<R;bi++){
      if(s.bb_upper[bi-1]!==null && s.bb_upper[bi]!==null && s.bb_upper[bi-1]!==undefined && s.bb_upper[bi]!==undefined)
        polygons.push([bi-1,s.bb_lower[bi-1],s.bb_upper[bi-1],bi,s.bb_lower[bi],s.bb_upper[bi]]);
    }
    bands.push({name:'通道填色',type:'custom',silent:true,z:0,tooltip:{show:false},xAxisIndex:0,yAxisIndex:0,
      data:polygons,encode:{x:[0,3],y:[1,2,4,5]},renderItem:function(params,api){
        var points=[api.coord([api.value(0),api.value(1)]),api.coord([api.value(0),api.value(2)]),
                    api.coord([api.value(3),api.value(5)]),api.coord([api.value(3),api.value(4)])];
        return {type:'polygon',shape:{points:echarts.graphic.clipPointsByRect(points,params.coordSys)},style:{fill:'rgba(117,153,255,.10)'}};
      }});
    bands.push(line('布林上軌',s.bb_upper,C.s1,1.2),line('布林中軌',s.bb_mid,'#d9c88f',1),line('布林下軌',s.bb_lower,C.s1,1.2));
  }

  /* ---- 型態：索引換算成目前區間 ---- */
  var evAt={}, inView={};
  if(pat){
    pat.events.forEach(function(e){
      var j=e.i-v.off; if(j<0||j>=R) return;
      (evAt[j]=evAt[j]||[]).push(e); inView[e.key]=(inView[e.key]||0)+1;
    });
  }
  var marks=[], markFont=11*fontScale;
  Object.keys(evAt).forEach(function(key){
    var j=Number(key), above=0, below=0;
    evAt[j].forEach(function(e){
      var d=DEF[e.key]; if(!d||!patShown(e.key)||/^(gap_|hs_)/.test(e.key)) return;
      var bear=d.dir==='bear', k=bear?above++:below++;
      marks.push({value:[j, bear?s.high[j]:s.low[j]], pat:e.key,
        label:{show:true,position:bear?'top':'bottom',distance:3+k*(markFont+3),formatter:dirGlyph(d.dir)+d.short,
               color:dirColor(d.dir),fontSize:markFont,fontWeight:'bold',textBorderColor:'rgba(10,13,20,.9)',textBorderWidth:2}});
    });
  });
  var gapData=[];
  if(pat) pat.gaps.forEach(function(g){
    if(!patShown(g.dir==='up'?'gap_up':'gap_down')) return;
    var a0=Math.max(0,g.i-1-v.off), a1=Math.min(R-1,g.end-v.off);
    if(a1<0||a0>=R||a1<a0) return;
    gapData.push([a0,a1,g.lo,g.hi,g.dir==='up'?1:-1,g.filled?1:0,g.i-1-v.off<0?1:0]);   /* 最後一欄：區間之前就出現的舊缺口，畫淡一點 */
  });
  var hsItems=[];
  if(pat) pat.hs.forEach(function(x){
    if(!patShown(x.key)) return;
    var pts=x.points.map(function(p){return [p[0]-v.off,p[1]];});
    if(pts[0][0]<0) return;
    hsItems.push({x:x, pts:pts, neck:x.neck.map(function(p){return [p[0]-v.off,p[1]];})});
  });
  if(marks.length||hsItems.length){
    /* 標記與頭肩標籤需要空間：頭肩底的標籤放在頭部下方、頭肩頂放在上方，那一側多留一點 */
    var rg=dHi-dLo, hb=hsItems.some(function(it){return it.x.key==='hs_bottom';}), ht=hsItems.some(function(it){return it.x.key==='hs_top';});
    dLo-=rg*(hb?0.2:0.05); dHi+=rg*(ht?0.2:0.05);
  }

  var pad = (dHi - dLo) * 0.04;
  function niceStep(range, target){
    var raw = (range || 1) / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  var node=el('k1'), W=node.clientWidth||900, Hh=node.clientHeight||480;
  k1Width=node.clientWidth||0;
  var yStep = niceStep((dHi + pad) - (dLo - pad), Hh>420?8:6);
  var yMin = Math.floor((dLo - pad) / yStep) * yStep, yMax = Math.ceil((dHi + pad) / yStep) * yStep;
  var yDigits = yStep >= 1 ? 0 : yStep >= 0.1 ? 1 : 2;
  var yFmt=function(x){return x.toLocaleString('zh-TW',{minimumFractionDigits:yDigits,maximumFractionDigits:yDigits});};
  var vMaxRaw = Math.max.apply(null, s.vol.filter(function(x){return x!==null;}).concat([1]));
  var vStep = niceStep(vMaxRaw, 2), vMax = Math.ceil(vMaxRaw / vStep) * vStep;
  function volLabel(x){ return x>=10000 ? (x/10000).toFixed(x%10000?1:0)+'萬' : x.toLocaleString('zh-TW'); }
  /* 費波南希標籤只留彼此不重疊的（完整價位在讀數列與滑鼠提示） */
  if(fibLines.length){
    var plotPx = Math.max(120, Hh * 0.6);
    var gap = (yMax - yMin) * 13 * fontScale / plotPx, taken = [];
    mlines.forEach(function(m){ if(m.name==='20日成交均價') taken.push(m.yAxis + gap/2); });
    [0.618,0.382,0.5,0.236,0.786,0,1].forEach(function(r){
      var m = fibLines.filter(function(x){return x.fibRatio===r;})[0]; if(!m) return;
      var center = m.yAxis - gap/2;
      if(taken.every(function(tk){return Math.abs(tk-center) >= gap;})){ m.label.show = true; taken.push(center); }
    });
  }
  /* 收盤價標籤 */
  var lastClose=s.close[R-1];
  mlines.push({name:'收盤',yAxis:lastClose,lineStyle:{color:'#9aa3b8',type:'dotted',opacity:.7,width:1},
    label:{show:true,position:'end',formatter:nf(lastClose),color:'#fff',backgroundColor:'#3a4356',padding:[2,5],borderRadius:3,fontSize:11}});

  /* ---- 版面：左邊價格刻度、右邊籌碼成本分佈 ---- */
  var narrow=W<640;
  var vpW=K1.vp ? (narrow ? Math.round(W*0.24) : Math.round(Math.min(280,Math.max(150,W*0.2)))) : 0;
  var labChars=Math.max(yFmt(yMin).length,yFmt(yMax).length);
  var leftW=Math.round(Math.max(labChars*6.8,40)*fontScale)+12;
  var rightW=vpW ? vpW+(narrow?30:44) : 44;
  var gTop=28, gH='63%';
  var bins=Math.round(Math.max(22,Math.min(48,Hh*0.6/9)));
  var vp=K1.vp ? volumeProfile(s,0,R-1,bins) : null;
  var vparts=vpSeriesParts(vp);
  var n1 = el('n1');
  if(n1){ n1.textContent = offnote.join('　·　'); n1.style.display = offnote.length ? '' : 'none'; }

  var series=bands.concat([
    {id:'k',name:'日K',type:'candlestick',data:kd,xAxisIndex:0,yAxisIndex:0,z:4,barMaxWidth:14,
     itemStyle:{color:alpha(C.up,.38),color0:C.down,borderColor:C.up,borderColor0:C.down,borderWidth:1.1},
     markLine:{symbol:'none',silent:true,label:{fontSize:10,color:C.ink2,backgroundColor:'rgba(21,26,36,.86)',padding:[1,4],borderRadius:3,
                formatter:function(p){return (p.data&&p.data.xAxis!==undefined)?p.name:p.name+' '+nf(p.value);}},
       lineStyle:{type:'dashed',width:1}, data:mlines.concat(vparts.candleLine)},
     markArea:{silent:true,data:areas.concat(vparts.candleArea)}},
    line('MA5',s.ma5,MAC[0],1.5), line('MA10',s.ma10,MAC[1],1.3),
    line('MA20',s.ma20,MAC[2],1.7), line('MA60',s.ma60,MAC[3],1.7),
    {name:'量',type:'bar',data:vols,xAxisIndex:1,yAxisIndex:1,barWidth:'62%',barMaxWidth:14}
  ]);
  if(gapData.length) series.push({id:'gaps',name:'跳空缺口',type:'custom',silent:true,z:1,xAxisIndex:0,yAxisIndex:0,tooltip:{show:false},
    data:gapData,encode:{x:[0,1],y:[2,3]},renderItem:function(params,api){
      var up=api.value(4)>0, bw=api.size([1,0])[0];
      var p0=api.coord([api.value(0),api.value(3)]), p1=api.coord([api.value(1),api.value(2)]);
      var shape=echarts.graphic.clipRectByRect({x:p0[0]-bw/2,y:p0[1],width:p1[0]-p0[0]+bw,height:Math.max(1.5,p1[1]-p0[1])},params.coordSys);
      if(!shape) return null;
      var old=api.value(6)>0;
      return {type:'rect',shape:shape,style:{fill:alpha(up?C.up:C.down,old?0.04:api.value(5)?0.08:0.16),stroke:alpha(up?C.up:C.down,old?.35:.75),lineWidth:1,lineDash:[4,3]}};
    }});
  if(hsItems.length) series.push({id:'hs',name:'頭肩型態',type:'custom',silent:true,z:5,xAxisIndex:0,yAxisIndex:0,tooltip:{show:false},clip:true,
    data:hsItems.map(function(it){return it.pts[2];}),encode:{x:0,y:1},renderItem:function(params,api){
      var it=hsItems[params.dataIndex]; if(!it) return null;
      var top=it.x.key==='hs_top', col=top?C.down:C.up, f=Math.round(12*fontScale);
      var P2=it.pts.map(function(p){return api.coord(p);}), n0=api.coord(it.neck[0]), n9=api.coord(it.neck[1]);
      var cs=params.coordSys, cy=function(y){return Math.max(cs.y+12,Math.min(cs.y+cs.height-12,y));};
      var dy=top?-1:1, kids=[
        {type:'polyline',shape:{points:P2},style:{stroke:col,lineWidth:1.3,lineDash:[2,3],fill:null}},
        {type:'line',shape:{x1:n0[0],y1:n0[1],x2:n9[0],y2:n9[1]},style:{stroke:C.warn,lineWidth:1.5,lineDash:[7,4]}}];
      [[0,'左肩'],[2,'頭'],[4,'右肩']].forEach(function(q){
        var p=P2[q[0]];
        kids.push({type:'text',x:p[0],y:cy(p[1]+dy*(8+markFont)),style:{text:q[1],fill:col,font:'bold '+f+'px sans-serif',align:'center',verticalAlign:'middle',
          stroke:'rgba(10,13,20,.9)',lineWidth:3}});
      });
      var hp=P2[2];
      var by=hp[1]+dy*(22+markFont*1.6);
      kids.push({type:'text',x:hp[0],y:Math.max(cs.y+11,Math.min(cs.y+cs.height-11,by)),style:{text:(top?'頭肩頂':'頭肩底')+(it.x.confirmed?'✓':'?'),fill:'#fff',
        backgroundColor:alpha(col,.92),padding:[3,8],borderRadius:4,font:'bold '+f+'px sans-serif',align:'center',verticalAlign:'middle'}});
      return {type:'group',children:kids};
    }});
  if(marks.length) series.push({id:'marks',name:'型態標註',type:'scatter',data:marks,symbolSize:1,itemStyle:{color:'transparent'},
    z:6,silent:true,xAxisIndex:0,yAxisIndex:0,tooltip:{show:false}});
  if(vp) series.push({id:'vp',name:'籌碼成本分佈',type:'custom',silent:true,xAxisIndex:2,yAxisIndex:2,tooltip:{show:false},
    data:vparts.data,encode:{x:[2,3],y:[0,1]},renderItem:function(params,api){
      var lo=api.value(0), hi=api.value(1), u=api.value(2), d=api.value(3), isPoc=api.value(4)>0, inVa=api.value(5)>0;
      var p0=api.coord([0,hi]), p1=api.coord([u,lo]), p2=api.coord([u+d,lo]);
      var h=Math.max(1,p1[1]-p0[1]-1);
      var au=isPoc?.95:inVa?.62:.34, ad=isPoc?.95:inVa?.6:.32;
      return {type:'group',children:[
        {type:'rect',shape:{x:p0[0],y:p0[1],width:Math.max(0,p1[0]-p0[0]),height:h},style:{fill:alpha(C.up,au)}},
        {type:'rect',shape:{x:p1[0],y:p0[1],width:Math.max(0,p2[0]-p1[0]),height:h},style:{fill:alpha(C.down,ad)}}]};
    },
    markLine:{symbol:'none',silent:true,data:vparts.line},markArea:{silent:true,data:vparts.area}});

  var legendNames=['MA5','MA10','MA20','MA60'].concat(K1.bb?['布林上軌','布林中軌','布林下軌']:[]);
  var selected=Object.assign({MA10:false},K1.legend||{});
  var chart=mk('k1', Object.assign(base(),{
    legend:{type:'scroll',data:legendNames,selected:selected,top:0,left:leftW-4,right:rightW,itemWidth:14,itemHeight:2,
            itemGap:12,textStyle:{color:C.ink2,fontSize:11},inactiveColor:'#555b68'},
    graphic:vp?[{type:'text',right:10,top:4,silent:true,style:{text:narrow?'籌碼分佈':'籌碼成本分佈（價值區 70%）',fill:C.ink2,font:'600 12px sans-serif'}}]:[],
    grid:[{left:leftW,right:rightW,top:gTop,height:gH},
          {left:leftW,right:rightW,top:'72%',bottom:24},
          {right:8,width:Math.max(40,vpW-8),top:gTop,height:gH}],
    axisPointer:{link:[{xAxisIndex:[0,1]}],label:{backgroundColor:'#2a3243'}},
    tooltip:Object.assign(base().tooltip,{trigger:'axis',axisPointer:{type:'cross'},
      formatter:function(ps){
        if(!ps.length) return '';
        var i=s.date.indexOf(ps[0].axisValue); if(i<0) return '';
        var o='<b>'+s.date[i]+'</b><br>';
        var ch=s.close[i]-(i>0?s.close[i-1]:s.close[i]);
        o+='開 '+nf(s.open[i])+'　高 '+nf(s.high[i])+'<br>低 '+nf(s.low[i])+'　收 <b>'+nf(s.close[i])+'</b>'+
           ' <span style="color:'+(ch>=0?C.up:C.down)+'">'+arrow(ch)+sg(ch)+'</span><br>';
        o+='量 '+nf(s.vol[i],1)+' 張';
        ['ma5','ma10','ma20','ma60'].forEach(function(k,j){
          if(s[k][i]!=null) o+='<br>MA'+[5,10,20,60][j]+' '+nf(s[k][i]);
        });
        if(K1.bb&&s.bb_upper&&s.bb_upper[i]!=null) o+='<br>布林上 / 中 / 下 '+nf(s.bb_upper[i])+' / '+nf(s.bb_mid[i])+' / '+nf(s.bb_lower[i])+'<br>%B '+nf(s.bb_percent_b[i],3)+' · 寬度 '+nf(s.bb_width[i])+'%';
        (evAt[i]||[]).forEach(function(e){
          var d=DEF[e.key]; if(!d||!patShown(e.key)) return;
          var st=pat.stats[e.key]||{};
          o+='<div style="margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.14)"><b style="color:'+dirColor(d.dir)+'">'+dirGlyph(d.dir)+' '+esc(d.name)+'</b>';
          if(/^gap_/.test(e.key)){
            var g=pat.gaps.filter(function(x){return x.i-v.off===i;})[0];
            if(g) o+='　缺口 '+nf(g.lo)+'～'+nf(g.hi)+'（'+(g.filled?g.fill_date.slice(5)+' 已回補':'尚未回補')+'）';
          }
          if(/^hs_/.test(e.key)) o+='　收盤'+(e.key==='hs_top'?'跌破':'突破')+'頸線 ✓';
          o+='<br>'+statLine(st,5)+'<br>'+statLine(st,10);
          o+='<br>這一次之後 5 日：'+(e.f5===null||e.f5===undefined?'還不到 5 個交易日':'<span style="color:'+(e.f5>=0?C.up:C.down)+'">'+sg(e.f5)+'%</span>')+'</div>';
        });
        if(evAt[i]&&evAt[i].some(function(e){return patShown(e.key);})&&pat.baseline&&pat.baseline.n5)
          o+='<div style="opacity:.75;margin-top:3px">對照：全部交易日 5 日上漲 '+nf(pat.baseline.up5,0)+'%、平均 '+sg(pat.baseline.avg5)+'%</div>';
        return o;
      }}),
    xAxis:[ax({type:'category',data:s.date,gridIndex:0,boundaryGap:true,splitLine:{show:false},
               axisLabel:{show:false},axisPointer:{label:{show:true}}}),
           ax({type:'category',data:s.date,gridIndex:1,boundaryGap:true,splitLine:{show:false},
               axisLabel:{color:C.muted,fontSize:10,interval:Math.max(0,Math.ceil(R/(narrow?4:8))-1),
                          formatter:function(x){return R>250?x.slice(2,7).replace('-','/'):x.slice(2).replace(/-/g,'/');}}}),
           {type:'value',gridIndex:2,min:0,max:vparts.xmax,show:false}],
    yAxis:[ax({min:yMin,max:yMax,interval:yStep,gridIndex:0,position:'left',axisLabel:{color:C.muted,fontSize:10,formatter:yFmt}}),
           ax({min:0,max:vMax,interval:vStep,gridIndex:1,position:'left',splitLine:{show:false},
               axisLabel:{color:C.muted,fontSize:9,showMinLabel:false,formatter:volLabel}}),
           {type:'value',gridIndex:2,min:yMin,max:yMax,show:false}],
    dataZoom:[{type:'inside',xAxisIndex:[0,1],start:0,end:100},
              {type:'inside',yAxisIndex:[0],zoomOnMouseWheel:false,moveOnMouseWheel:false}],
    series:series
  }));
  if(chart){
    chart.on('legendselectchanged',function(e){ K1.legend=e.selected; saveK1(); });
    /* 縮放 K 棒時，籌碼分佈跟著可見區間重算 */
    var pending=null;
    if(vp) chart.on('datazoom',function(){
      if(pending) return;
      pending=requestAnimationFrame(function(){
        pending=null;
        var z=chart.getOption().dataZoom[0], a=Math.max(0,Math.round(z.startValue||0)), bb=Math.min(R-1,Math.round(z.endValue===undefined?R-1:z.endValue));
        var p=vpSeriesParts(volumeProfile(s,a,Math.max(a,bb),bins));
        chart.setOption({xAxis:[{},{},{max:p.xmax}],series:[{id:'k',markLine:{data:mlines.concat(p.candleLine)},markArea:{data:areas.concat(p.candleArea)}},
          {id:'vp',data:p.data,markLine:{data:p.line},markArea:{data:p.area}}]});
      });
    });
  }
  k1Summary(v, vp, evAt, inView, DEF);
  k1Legend(inView, DEF, v);
}

/* 圖下方的白話摘要 */
var lastK=null;
function k1Summary(v, vp, evAt, inView, DEF){
  var s=v.s, R=s.date.length, pat=P.patterns, parts=[];
  var cnt={bull:0,bear:0,neutral:0}, lastE=null;
  Object.keys(evAt).forEach(function(j){ evAt[j].forEach(function(e){ var d=DEF[e.key]; if(!d||!patShown(e.key)) return; cnt[d.dir]++; if(!lastE||e.i>lastE.i) lastE=e; }); });
  lastK={r:R, pat:K1.pat&&!!pat, vp:vp?{poc:vp.poc,vah:vp.vah,val:vp.val}:null, counts:pat&&K1.pat?cnt:null};
  var box=el('k-summary'); if(!box) return;
  if(pat && K1.pat){
    var t='<b>型態</b>　近 '+R+' 日：<span class="up">▲多方 '+cnt.bull+'</span>、<span class="down">▼空方 '+cnt.bear+'</span>、<span class="warn">◆中性 '+cnt.neutral+'</span>';
    if(lastE){ var d=DEF[lastE.key], st=pat.stats[lastE.key]||{};
      t+='　·　最近一次：'+s.date[lastE.i-v.off].slice(5)+' <b style="color:'+dirColor(d.dir)+'">'+esc(d.name)+'</b>（'+(st.n5?'歷史 5 日上漲 '+nf(st.up5,0)+'%，n='+st.n5:'歷史樣本不足')+'）'; }
    var hs=pat.hs.filter(function(x){return patShown(x.key)&&x.points[0][0]-v.off>=0;});
    hs.forEach(function(x){
      var nk=x.neck[1][1];
      t+='　·　<b style="color:'+(x.key==='hs_top'?C.down:C.up)+'">'+(x.key==='hs_top'?'頭肩頂':'頭肩底')+(x.confirmed?' ✓':' ?')+'</b> '+
        (x.confirmed?s.date[x['break']-v.off].slice(5)+' 收盤'+(x.key==='hs_top'?'跌破':'突破')+'頸線':'形成中，頸線約 '+nf(nk));
    });
    /* 只列這個區間內出現、到今天還沒回補的缺口（更早的舊缺口通常離現價很遠） */
    var open=pat.gaps.filter(function(g){return !g.filled&&patShown(g.dir==='up'?'gap_up':'gap_down')&&g.i-v.off>=0;});
    if(open.length){ var g=open[open.length-1];
      t+='　·　區間內尚未回補的缺口 '+open.length+' 個（最近 '+s.date[g.i-v.off].slice(5)+' '+(g.dir==='up'?'向上':'向下')+' '+nf(g.lo)+'～'+nf(g.hi)+'）'; }
    parts.push(t);
  }
  if(vp){
    var c=s.close[R-1], where=c>vp.vah?'在價值區上方（已站上壓力帶 VAH）':c<vp.val?'在價值區下方（跌破支撐帶 VAL）':'在價值區內';
    parts.push('<b>籌碼成本分佈</b>　POC <span class="warn">'+nf(vp.poc)+'</span> · 價值區 '+nf(vp.val)+'～'+nf(vp.vah)+'；收盤 '+nf(c)+' '+where+
      '　<span class="k-muted">（用每日最高～最低價平均攤成交量估計，縮放 K 棒時會跟著可見區間重算）</span>');
  }
  box.innerHTML=parts.map(function(x){return '<div>'+x+'</div>';}).join('');
  box.hidden=!parts.length;
}

/* 符號說明與歷史勝率表 */
function k1Legend(inView, DEF, v){
  var body=el('k-legend-body'); if(!body) return;
  var pat=P.patterns;
  if(!pat){ body.innerHTML='<p class="k-muted">這份報告沒有型態資料，請重新分析。</p>'; return; }
  var span=spanLabel(), base=pat.baseline||{};
  function pct(x){ return x===null||x===undefined?'—':nf(x,0)+'%'; }
  function avg(x){ return x===null||x===undefined?'—':'<span class="'+cls(x)+'">'+sg(x)+'%</span>'; }
  var rows=pat.defs.map(function(d){
    var st=pat.stats[d.key]||{}, few=(st.n5||0)<20;
    var sym=/^gap_/.test(d.key)?(d.dir==='up'||d.dir==='bull'?'紅色虛線框':'綠色虛線框'):/^hs_/.test(d.key)?d.name+' ✓／? ＋黃色虛線':dirGlyph(d.dir)+d.short;
    return '<tr'+(few?' class="k-few"':'')+'><td><span style="color:'+dirColor(d.dir)+'">'+esc(sym)+'</span></td><td>'+esc(d.name)+'<small>'+esc(d.rule)+'</small></td>'+
      '<td>'+(d.dir==='bull'?'<span class="up">看漲</span>':d.dir==='bear'?'<span class="down">看跌</span>':'<span class="warn">中性</span>')+'</td>'+
      '<td>'+(inView[d.key]||0)+'</td><td>'+(st.total||0)+'</td><td>'+pct(st.up5)+'</td><td>'+avg(st.avg5)+'</td><td>'+pct(st.up10)+'</td><td>'+avg(st.avg10)+'</td></tr>';
  }).join('');
  body.innerHTML='<div class="scroll"><table class="raw k-legend-table"><thead><tr><th>符號</th><th>名稱與判斷規則</th><th>多空</th><th>本區間</th><th>'+esc(span)+'次數</th>'+
    '<th>5 日上漲機率</th><th>5 日平均</th><th>10 日上漲機率</th><th>10 日平均</th></tr></thead><tbody>'+rows+
    '<tr class="k-base"><td>—</td><td>全部交易日（對照基準）</td><td>—</td><td>'+v.r+'</td><td>'+(base.total||0)+'</td><td>'+pct(base.up5)+'</td><td>'+avg(base.avg5)+'</td><td>'+pct(base.up10)+'</td><td>'+avg(base.avg10)+'</td></tr>'+
    '<tr><td><span class="warn">黃色虛線橫貫</span></td><td>POC 最大量價位（籌碼最密集的價格）</td><td>—</td><td colspan="6" class="k-muted">右側籌碼成本分佈：紅＝收紅K那幾天的量、綠＝收黑K的量</td></tr>'+
    '<tr><td><span style="color:#8fb0ff">淺藍色帶</span></td><td>價值區（涵蓋 70% 成交量；上緣 VAH 壓力、下緣 VAL 支撐）</td><td>—</td><td colspan="6" class="k-muted">收盤站上 VAH 常被視為突破密集區，跌破 VAL 則相反；只是描述，不是訊號</td></tr>'+
    '</tbody></table></div>'+
    '<p class="k-muted">統計期間 '+esc(pat.span.from)+' ～ '+esc(pat.span.to)+'（'+pat.span.bars+' 個交易日）。「上漲機率」＝型態出現那天收盤之後第 5／10 個交易日收盤較高的比例，「平均」是同期間報酬的平均；'+
    '頭肩型態以收盤突破／跌破頸線那天計。只用這一檔股票自己的歷史、未還原股價、不含交易成本；相鄰事件重疊、樣本少於 20 次的列以淡色顯示，都只能當參考，不代表之後會如此。</p>';
}

function buildK1Controls(){
  var sel=el('k-range');
  if(sel){
    var opts=kRanges(), W=kWindow(), cur=kRange(), n=P.kline?P.kline.date.length:opts[opts.length-1];
    sel.innerHTML=opts.map(function(r){
      var lab=r===W?(KSTD.indexOf(r)>=0?'近 '+r+' 日（分析天數）':'分析天數 '+r+' 日'):(KSTD.indexOf(r)<0&&r===n?'全部 '+r+' 日':'近 '+r+' 日');
      return '<option value="'+(r===W?0:r)+'"'+(r===cur?' selected':'')+'>'+lab+'</option>';
    }).join('');
  }
  var box=el('k-pats');
  if(box){
    var defs=(P.patterns&&P.patterns.defs)||[];
    if(!defs.length){ box.innerHTML=''; box.hidden=true; }
    else{
      var off=defs.filter(function(d){return K1.off[d.key];}).length;
      box.innerHTML='<button type="button" class="kp-more" aria-expanded="'+box.classList.contains('open')+'">選擇要標示的型態（'+(defs.length-off)+' / '+defs.length+'）</button>'+defs.map(function(d){
        return '<label class="kp" data-dir="'+d.dir+'" title="'+esc(d.rule)+'"><input type="checkbox" data-kpat="'+d.key+'"'+(K1.off[d.key]?'':' checked')+'>'+esc(d.name)+'</label>';
      }).join('')+'<span class="kp-actions"><button type="button" class="kp-all" data-kpat-all="1">全選</button><button type="button" class="kp-all" data-kpat-all="0">全不選</button></span>';
      box.hidden=!K1.pat;
    }
  }
  [['btn-vp','vp'],['btn-pat','pat'],['btn-sr','sr'],['btn-bb','bb'],['btn-fib','fib']].forEach(function(x){
    var b=el(x[0]); if(b) b.setAttribute('aria-pressed',String(!!K1[x[1]]));
  });
  var lg=el('k-legend'); if(lg) lg.hidden=!P.patterns;
}
function redrawK1(){
  if(!P) return;
  var node=el('k1'), ch=node&&echarts.getInstanceByDom(node);
  if(ch){ charts=charts.filter(function(c){return c!==ch;}); ch.dispose(); }
  buildK1Controls();
  if(node && !node.closest('[hidden]')) card01();
  var b=document.querySelector('[data-chart-png="k1"]'); if(b) b.disabled=!echarts.getInstanceByDom(el('k1'));
}
function bindK1(){
  [['btn-vp','vp'],['btn-pat','pat'],['btn-sr','sr'],['btn-bb','bb'],['btn-fib','fib']].forEach(function(x){
    var b=el(x[0]); if(!b) return;
    b.addEventListener('click',function(){ K1[x[1]]=!K1[x[1]]; saveK1(); redrawK1(); });
  });
  var sel=el('k-range');
  if(sel) sel.addEventListener('change',function(){ K1.range=Number(this.value); saveK1(); redrawK1(); });
  var box=el('k-pats');
  if(box){
    box.addEventListener('change',function(e){ var c=e.target.closest('[data-kpat]'); if(!c) return; if(c.checked) delete K1.off[c.dataset.kpat]; else K1.off[c.dataset.kpat]=true; saveK1(); redrawK1(); });
    box.addEventListener('click',function(e){
      var m=e.target.closest('.kp-more'); if(m){ var on=!box.classList.contains('open'); box.classList.toggle('open',on); m.setAttribute('aria-expanded',String(on)); return; }
      var b=e.target.closest('[data-kpat-all]'); if(!b) return;
      var on=b.dataset.kpatAll==='1'; K1.off={};
      if(!on) ((P&&P.patterns&&P.patterns.defs)||[]).forEach(function(d){K1.off[d.key]=true;});
      saveK1(); redrawK1(); });
  }
}

/* ========================================================================
   02 決策核心
   ======================================================================== */
function card02(){
  var t=P.tech, q=P.quote, sc=P.scores, pl=P.plan;
  var rows=[
    ['趨勢判斷', t.trend_txt, t.trend_txt==='多頭排列'?'up':(t.trend_txt==='空頭排列'?'down':'flat')],
    ['短線狀態', t.kd_txt, 'flat'],
    ['相對大盤 20日', (P.bench&&P.bench.d20)?sg(P.bench.d20.rs)+' 點':'無資料',
       (P.bench&&P.bench.d20)?cls(P.bench.d20.rs):'flat'],
    ['MA20 乖離', t.bias20===null?'—':sg(t.bias20)+'%', cls(t.bias20)],
    ['ATR / 20日位階', (t.atr_pct===null?'—':nf(t.atr_pct)+'%')+' / '+(t.pos20===null?'—':nf(t.pos20,0)+'%'), 'flat'],
    ['20日成交均價', nf(t.vwap20)+(t.vwap20===null?'':(q.close>=t.vwap20?'（價在其上）':'（價在其下）')), 'flat'],
    ['60日支撐 / 壓力', nf(t.support,0)+' / '+nf(t.resistance,0), 'flat'],
    ['法人籌碼分', sc.chip===null?'無資料':nf(sc.chip,0)+' 分', 'flat'],
    ['綜合評分', sc.overall===null?'—':nf(sc.overall,0)+' / 100', 'flat'],
    ['風險報酬比', pl.rr===null?'—':nf(pl.rr)+'（首目標）', 'flat'],
    ['進場態度', pl.verdict, pl.vclass==='bull'?'up':(pl.vclass==='bear'?'down':'flat')]
  ];
  var alert=el('decision-alert');
  var incomplete=!P.avail.indicators_ready || sc.chip===null || (P.fetch_info && P.fetch_info.warnings.length);
  alert.dataset.state=incomplete?'mild':pl.vclass;
  alert.textContent=incomplete?'△ 資料待補 · 請留意缺漏':'◎ '+pl.verdict;
  el('t2').innerHTML = rows.map(function(r){
    return '<tr><td>'+esc(r[0])+'</td><td class="'+r[2]+'">'+esc(r[1])+'</td></tr>';
  }).join('');
}

/* ========================================================================
   03 多維度雷達
   ======================================================================== */
function card03(){
  var sc=P.scores, t=P.tech;
  var dims=[['趨勢',sc.trend],['動能',sc.momentum],['籌碼',sc.chip],
            ['量價',sc.volume],['位階',t.pos60],['技術',sc.tech]];
  var miss=dims.filter(function(d){return d[1]===null;}).map(function(d){return d[0];});
  el('n3').textContent = (sc.overall===null?'資料不足':'綜合 '+nf(sc.overall,0)+' / 100')+
     (miss.length?'　·　無資料：'+miss.join('、'):'　·　規則計分，非勝率');
  var vals=dims.map(function(d){return d[1]===null?0:d[1];});
  mk('k3', Object.assign(base(),{
    graphic:[{type:'text',left:'center',top:'47%',silent:true,style:{text:sc.overall===null?'—':nf(sc.overall,0),fill:C.s1,font:'700 32px sans-serif'}},{type:'text',left:'center',top:'62%',silent:true,style:{text:'綜合規則分',fill:C.muted,font:'10px sans-serif'}}],
    tooltip:Object.assign(base().tooltip,{trigger:'item',formatter:function(){
      return dims.map(function(d){return d[0]+'：'+(d[1]===null?'無資料':nf(d[1],0));}).join('<br>');}}),
    radar:{indicator:dims.map(function(d){return {name:d[0],max:100};}),
      center:['50%','54%'],radius:'64%',splitNumber:4,
      axisName:{color:C.ink2,fontSize:11},
      splitLine:{lineStyle:{color:C.grid}}, axisLine:{lineStyle:{color:C.grid}},
      splitArea:{areaStyle:{color:['rgba(255,255,255,.015)','rgba(255,255,255,.035)']}}},
    series:[{type:'radar',symbolSize:6,
      data:[{value:vals,name:'評分',
        lineStyle:{color:C.up,width:2}, itemStyle:{color:C.up},
        areaStyle:{color:'rgba(235,102,104,.20)'}}]}]
  }));
}

/* ========================================================================
   04 價量熱區
   ======================================================================== */
function card04(){
  var h=P.heat;
  mk('k4', Object.assign(base(),{
    tooltip:Object.assign(base().tooltip,{trigger:'item',formatter:function(p){
      return h.x[p.value[0]]+'　'+h.y[p.value[1]]+' 元收盤價桶<br>歸入全日成交量 <b>'+nf(p.value[2],0)+'</b> 張';}}),
    grid:{left:4,right:8,top:6,bottom:34,containLabel:true},
    xAxis:ax({type:'category',data:h.x,splitLine:{show:false},
      axisLabel:{color:C.muted,fontSize:9,interval:Math.max(0,Math.ceil(h.x.length/5)-1)}}),
    yAxis:ax({type:'category',data:h.y,splitLine:{show:false},
      axisLabel:{color:C.muted,fontSize:9,interval:2}}),
    visualMap:{min:0,max:h.max||1,calculable:false,orient:'horizontal',
      left:'center',bottom:0,itemWidth:9,itemHeight:58,text:['多','少'],
      textStyle:{color:C.muted,fontSize:9},
      inRange:{color:C.seq}},
    series:[{type:'heatmap',data:h.data,progressive:0,
      itemStyle:{borderColor:'rgba(21,26,36,.9)',borderWidth:1}}]
  }));
}

/* ========================================================================
   05 技術風險雷達
   ======================================================================== */
function card05(){
  var t=P.tech;
  var biasN = t.bias20===null?null:Math.max(0,Math.min(100,50+t.bias20*3));
  var atrN  = t.atr_pct===null?null:Math.max(0,Math.min(100,t.atr_pct*10));
  var dims=[['RSI14',t.rsi],['K值',t.k],['D值',t.d],
            ['60日位階',t.pos60],['ATR波動',atrN],['MA20乖離',biasN]];
  el('n5').textContent='ATR 波動 '+(t.atr_pct===null?'—':nf(t.atr_pct)+'%')+
    '　·　乖離與波動已換算為 0–100 相對刻度';
  mk('k5', Object.assign(base(),{
    tooltip:Object.assign(base().tooltip,{trigger:'item',formatter:function(){
      return 'RSI14 '+nf(t.rsi,1)+'<br>K '+nf(t.k,1)+'　D '+nf(t.d,1)+
             '<br>60日位階 '+nf(t.pos60,0)+'%<br>ATR '+nf(t.atr_pct)+'%<br>乖離 '+sg(t.bias20)+'%';}}),
    radar:{indicator:dims.map(function(d){return {name:d[0],max:100};}),
      center:['50%','53%'],radius:'46%',splitNumber:4,
      axisName:{color:C.ink2,fontSize:9.5},
      splitLine:{lineStyle:{color:C.grid}}, axisLine:{lineStyle:{color:C.grid}},
      splitArea:{areaStyle:{color:['rgba(255,255,255,.015)','rgba(255,255,255,.035)']}}},
    series:[{type:'radar',symbolSize:5,
      data:[{value:dims.map(function(d){return d[1]===null?0:d[1];}),
        lineStyle:{color:C.serious,width:2}, itemStyle:{color:C.serious},
        areaStyle:{color:'rgba(236,131,90,.22)'}}]}]
  }));
}

/* ========================================================================
   06 KD
   ======================================================================== */
function card06(){
  var s=P.series,t=P.tech;
  el('t6sub').textContent='K '+nf(t.k,1)+'　D '+nf(t.d,1);
  mk('k6', Object.assign(base(),{
    legend:{data:['K','D'],top:0,right:0,itemWidth:14,itemHeight:2,textStyle:{color:C.ink2,fontSize:11}},
    grid:{left:18,right:14,top:22,bottom:20,containLabel:true},
    tooltip:Object.assign(base().tooltip,{trigger:'axis',axisPointer:{type:'line'}}),
    xAxis:ax({type:'category',data:s.date,boundaryGap:false,splitLine:{show:false},
      axisLabel:{color:C.muted,fontSize:9,interval:Math.ceil(s.date.length/6),
                 formatter:function(v){return v.slice(5);}}}),
    yAxis:ax({min:0,max:100,splitNumber:4}),
    series:[
      {name:'K',type:'line',data:s.k,symbol:'none',lineStyle:{width:1.8,color:C.s2},connectNulls:false,
       markLine:{symbol:'none',silent:true,lineStyle:{type:'dashed',color:C.axis,width:1},
         label:{color:C.muted,fontSize:9,position:'insideStartTop',formatter:function(p){return p.name;}},
         data:[{name:'80 超買',yAxis:80},
               {name:'20 超賣',yAxis:20,label:{position:'insideStartBottom'}}]}},
      {name:'D',type:'line',data:s.d,symbol:'none',lineStyle:{width:1.8,color:C.s1},connectNulls:false}
    ]
  }));
}

/* ========================================================================
   07 MACD
   ======================================================================== */
function card07(){
  var s=P.series,t=P.tech;
  el('t7sub').textContent='DIF '+nf(t.dif)+'　OSC '+nf(t.osc);
  var bars=s.osc.map(function(v){ return v===null?null:{value:v,
    itemStyle:{color:v>=0?C.up:C.down,opacity:.8}}; });
  mk('k7', Object.assign(base(),{
    legend:{data:['DIF','訊號線','OSC'],top:0,right:0,itemWidth:14,itemHeight:2,textStyle:{color:C.ink2,fontSize:11}},
    grid:{left:18,right:14,top:22,bottom:20,containLabel:true},
    tooltip:Object.assign(base().tooltip,{trigger:'axis',axisPointer:{type:'line'}}),
    xAxis:ax({type:'category',data:s.date,boundaryGap:true,splitLine:{show:false},
      axisLabel:{color:C.muted,fontSize:9,interval:Math.ceil(s.date.length/6),
                 formatter:function(v){return v.slice(5);}}}),
    yAxis:ax({scale:true}),
    series:[
      {name:'OSC',type:'bar',data:bars,barWidth:'56%',z:2},
      {name:'DIF',type:'line',data:s.dif,symbol:'none',lineStyle:{width:1.8,color:C.s2},z:3,connectNulls:false},
      {name:'訊號線',type:'line',data:s.sig,symbol:'none',lineStyle:{width:1.8,color:C.s1},z:3,connectNulls:false}
    ]
  }));
}

/* ========================================================================
   08 三大法人
   ======================================================================== */
function card08(){
  var s=P.series, cp=P.chip;
  if(!cp.has_data){
    el('t8sub').textContent='無資料';
    emptyCard(el('w8'),'未取得三大法人買賣超資料','此資料來源或此標的未提供');
    return;
  }
  el('t8sub').textContent=cp.net5===null?'近5日資料不足（'+cp.coverage5+'/5日）':'近5日合計 '+sg(cp.net5,0)+' 張';
  el('lg8').innerHTML=[['外資',C.s1],['投信',C.s2],['自營商',C.s3]].map(function(d){
    return '<span><i style="background:'+d[1]+'"></i>'+d[0]+'</span>';}).join('');

  var n=Math.min(30,s.date.length);
  var dd=s.date.slice(-n);
  var ser=function(name,key,color){ return {name:name,type:'bar',stack:'x',
    data:s[key].slice(-n),barWidth:'62%',
    itemStyle:{color:color,borderColor:css('--surface'),borderWidth:1}}; };

  mk('k8', Object.assign(base(),{
    grid:{left:16,right:12,top:6,bottom:18,containLabel:true},
    tooltip:Object.assign(base().tooltip,{trigger:'axis',axisPointer:{type:'shadow'},
      formatter:function(ps){
        if(!ps.length) return '';
        var o='<b>'+ps[0].axisValue+'</b>',tot=0, count=0;
        ps.forEach(function(p){ if(p.value!=null){ count++; tot+=p.value;
          o+='<br>'+p.marker+p.seriesName+'　'+sg(p.value,0)+' 張'; }});
        return o+'<br><span style="color:'+C.muted+'">合計 '+(count===3?sg(tot,0)+' 張':'資料不足')+'</span>';}}),
    xAxis:ax({type:'category',data:dd,splitLine:{show:false},
      axisLabel:{color:C.muted,fontSize:9,interval:Math.ceil(n/5),
                 formatter:function(v){return v.slice(5);}}}),
    yAxis:ax({scale:true,axisLabel:{color:C.muted,fontSize:9,
      formatter:function(v){return Math.abs(v)>=1000?(v/1000).toFixed(0)+'k':v;}}}),
    series:[ser('外資','chip_foreign',C.s1),ser('投信','chip_trust',C.s2),ser('自營商','chip_dealer',C.s3)]
  }));

  el('tb8').innerHTML='<table class="chiptab"><thead><tr><th>日期</th><th>外資</th><th>投信</th><th>自營</th><th>合計</th></tr></thead><tbody>'+
    cp.recent.map(function(r){
      return '<tr><td>'+r.date.slice(5)+'</td>'+
        ['foreign','trust','dealer','total'].map(function(k){
          return '<td class="'+cls(r[k])+'">'+sg(r[k],0)+'</td>';}).join('')+'</tr>';
    }).join('')+'</tbody></table><div class="note">單位：張</div>';
}

/* ========================================================================
   09 風險監測 / 10 多空能量 / 14 資料可用度  (HTML 橫條)
   ======================================================================== */
function bar(label,val,max,color,disp){
  var pct = val===null?0:Math.max(0,Math.min(100,val/max*100));
  return '<div class="barrow"><span class="bl">'+esc(label)+'</span>'+
    '<span class="bt"><span class="bf" style="width:'+pct.toFixed(1)+'%;background:'+color+'"></span></span>'+
    '<span class="bv">'+(disp!==undefined?disp:(val===null?'—':nf(val,0)))+'</span></div>';
}
function zone(v,lo,hi){ if(v===null) return C.muted; return v>=hi?C.crit:(v<=lo?C.s1:C.warn); }

function card09(){
  var t=P.tech;
  el('b9').innerHTML=
    bar('RSI14',t.rsi,100,zone(t.rsi,30,70),t.rsi===null?'—':nf(t.rsi,0))+
    bar('K值',t.k,100,zone(t.k,20,80),t.k===null?'—':nf(t.k,0))+
    bar('D值',t.d,100,zone(t.d,20,80),t.d===null?'—':nf(t.d,0))+
    bar('20日位階',t.pos20,100,zone(t.pos20,25,75),t.pos20===null?'—':nf(t.pos20,0))+
    bar('60日位階',t.pos60,100,zone(t.pos60,25,75),t.pos60===null?'—':nf(t.pos60,0));
  el('n9').textContent='藍=低檔區　黃=中性　紅=高檔區（僅描述指標位置，不預測方向）';
}

function card10(){
  var t=P.tech;
  el('b10').innerHTML=
    bar('上漲日',t.up_ratio,100,C.up,nf(t.up_ratio,0)+'%')+
    bar('下跌日',t.down_ratio,100,C.down,nf(t.down_ratio,0)+'%');
  el('n10').textContent=P.bars_count+' 個交易日中 '+t.ups+' 漲 / '+t.downs+' 跌 / '+t.flats+' 平（歷史統計，非預測）';
}

function card14(){
  var a=P.avail;
  var pd=Math.min(100,a.price_days/a.need_days*100);
  var cd=Math.min(100,a.chip_days/a.need_days*100);
  el('b14').innerHTML=
    bar('價量',pd,100,C.s1,a.price_days+' / '+a.need_days+' 日')+
    bar('法人',cd,100,a.chip_days?C.s1:C.muted,a.chip_days+' / '+a.need_days+' 日')+
    bar('融資券',a.margin_current?100:0,100,a.margin_current?C.s1:C.muted,
        a.margin_current?'同日完整':a.margin?'落後／缺值':'無資料');
  el('n14').textContent='指標所需筆數：'+(a.indicators_ready?'足夠':'不足')+
    '；法人近5日 '+P.chip.coverage5+'/5、近20日 '+P.chip.coverage20+'/20。';
}

/* ========================================================================
   11 / 17 儀表
   ======================================================================== */
function gaugeSet(id, items){
  var node=el(id); if(!node) return;
  var n=items.length;
  var S = n>=4?76:110, R = n>=4?29:43, W = n>=4?6:8;
  var CIRC = 2*Math.PI*R, cxy = S/2;
  node.className='rings';
  node.innerHTML = items.map(function(it){
    var v=it.v, has=(v!==null&&v!==undefined);
    var off = CIRC*(1-(has?Math.max(0,Math.min(100,v)):0)/100);
    var lab = it.n+' '+(has?Math.round(v)+' 分':'無資料');
    return '<div class="ring">'+
      '<svg width="'+S+'" height="'+S+'" viewBox="0 0 '+S+' '+S+'" role="img" aria-label="'+esc(lab)+'">'+
        '<circle cx="'+cxy+'" cy="'+cxy+'" r="'+R+'" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="'+W+'"/>'+
        (has?('<circle cx="'+cxy+'" cy="'+cxy+'" r="'+R+'" fill="none" stroke="'+it.c+'" stroke-width="'+W+'"'+
              ' stroke-linecap="round" stroke-dasharray="'+CIRC.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'"'+
              ' transform="rotate(-90 '+cxy+' '+cxy+')"/>'):'')+
        '<text x="'+cxy+'" y="'+cxy+'" text-anchor="middle" dominant-baseline="central"'+
        ' fill="'+(has?C.ink:C.muted)+'" font-size="'+((n>=4?18:26)*fontScale)+'" font-weight="700"'+
        ' font-family="inherit" style="font-variant-numeric:tabular-nums">'+(has?Math.round(v):'—')+'</text>'+
      '</svg>'+
      '<div class="rl">'+esc(it.n)+'</div></div>';
  }).join('');
}
function scoreColor(v){ if(v===null||v===undefined) return C.muted;
  /* 單一藍色 sequential ramp：高分較亮。不用紅/綠，避免與「紅漲綠跌」混淆 */
  return v>=75?C.seq[5]:(v>=60?C.seq[4]:(v>=45?C.seq[3]:C.seq[2])); }

function card11(){
  var t=P.tech, sc=P.scores;
  gaugeSet('k11',[
    {n:'RSI14',v:t.rsi,c:zone(t.rsi,30,70)},
    {n:'K值',v:t.k,c:zone(t.k,20,80)},
    {n:'D值',v:t.d,c:zone(t.d,20,80)},
    {n:'技術分',v:sc.tech,c:scoreColor(sc.tech)}
  ]);
}
function card17(){
  var sc=P.scores;
  gaugeSet('k17',[
    {n:'技術',v:sc.tech,c:scoreColor(sc.tech)},
    {n:'籌碼',v:sc.chip,c:scoreColor(sc.chip)},
    {n:'綜合',v:sc.overall,c:scoreColor(sc.overall)}
  ]);
}

/* ========================================================================
   12 動能燈號
   ======================================================================== */
function card12(){
  var t=P.tech, sc=P.scores, cp=P.chip;
  var rows=[];
  rows.push(['趨勢', t.trend_txt, t.trend_txt==='多頭排列'?C.good:(t.trend_txt==='空頭排列'?C.crit:C.warn)]);
  rows.push(['動能', t.osc===null?'無資料':(t.osc>0?'OSC 為正':'OSC 為負'),
             t.osc===null?C.muted:(t.osc>0?C.good:C.crit)]);
  rows.push(['籌碼', cp.net5===null?'近5日資料不足':(cp.net5>0?'近5日法人買超':cp.net5<0?'近5日法人賣超':'近5日法人持平'),
             cp.net5===null||cp.net5===0?C.muted:(cp.net5>0?C.good:C.crit)]);
  rows.push(['乖離', t.bias20===null?'無資料':nf(t.bias20)+'%',
             t.bias20===null?C.muted:(Math.abs(t.bias20)>10?C.crit:(Math.abs(t.bias20)>5?C.warn:C.good))]);
  var v=P.volume_analysis||{};
  rows.push(['量價',v.state||'無資料',v.score===null||v.score===undefined?C.muted:v.score>50?C.up:v.score<50?C.down:C.muted]);
  el('l12').innerHTML=rows.map(function(r){
    return '<div class="lamp"><span class="dot" style="background:'+r[2]+'"></span>'+
      '<span class="lk">'+esc(r[0])+'</span><span class="lv">'+esc(r[1])+'</span></div>';}).join('');
  el('n12').textContent='燈號＝顏色＋文字，不以顏色單獨表意';
}

/* ========================================================================
   13 價格區間量分布
   ======================================================================== */
function card13(){
  var vp=P.volprice, c=P.quote.close;
  var cur=-1, best=1e18;
  vp.y.forEach(function(p,i){ var d=Math.abs(Number(p)-c); if(d<best){best=d;cur=i;} });
  mk('k13', Object.assign(base(),{
    tooltip:Object.assign(base().tooltip,{trigger:'item',formatter:function(p){
      return p.name+' 元收盤價桶<br>歸入全日成交量 <b>'+nf(p.value,0)+'</b> 張';}}),
    grid:{left:4,right:12,top:6,bottom:8,containLabel:true},
    xAxis:ax({type:'value',splitLine:{show:true,lineStyle:{color:C.grid}},
      axisLabel:{color:C.muted,fontSize:9,formatter:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}}}),
    yAxis:ax({type:'category',data:vp.y,splitLine:{show:false},
      axisLabel:{color:C.muted,fontSize:9,interval:1}}),
    series:[{type:'bar',data:vp.v.map(function(v,i){
        return {value:v,itemStyle:{color:i===cur?C.s2:C.s1,opacity:i===cur?1:.62,
                borderRadius:[0,3,3,0]}};}),
      barWidth:'70%',
      markLine:{symbol:'none',silent:true,lineStyle:{color:C.s2,type:'dashed',width:1},
        label:{formatter:'現價','color':C.s2,fontSize:9,position:'insideEndTop'},
        data:cur>=0?[{yAxis:cur}]:[]}}]
  }));
}

/* ========================================================================
   15 籌碼異動
   ======================================================================== */
function card15(){
  var cp=P.chip, s=P.series;
  if(!cp.has_data){ el('t15sub').textContent='無資料'; emptyCard(el('w15'),'未取得三大法人資料'); return; }
  var l=cp.last;
  el('t15sub').textContent=l.date+(cp.stale?'（落後股價）':'')+(cp.coverage20<20?' · 近20日缺漏':'');
  el('t15').innerHTML=[['外資',l.foreign],['投信',l.trust],['自營商',l.dealer],['三大法人',l.total]]
    .map(function(r){ return '<tr><td>'+r[0]+'</td><td class="'+cls(r[1])+'">'+
      arrow(r[1])+' '+sg(r[1],0)+' 張</td></tr>';}).join('');
  var cum=[],acc=0,complete=true;
  s.chip_total.forEach(function(v){
    if(v===null) complete=false;
    if(complete) acc+=v;
    cum.push(complete?acc:null);
  });
  mk('k15', Object.assign(base(),{
    tooltip:Object.assign(base().tooltip,{trigger:'axis',formatter:function(ps){
      var p=ps[0]; return s.date[p.dataIndex]+'<br>累計 '+sg(p.value,0)+' 張';}}),
    grid:{left:0,right:0,top:6,bottom:2},
    xAxis:{type:'category',data:s.date,show:false,boundaryGap:false},
    yAxis:{type:'value',scale:true,show:false},
    series:[{type:'line',data:cum,symbol:'none',connectNulls:false,
      lineStyle:{width:1.6,color:acc>=0?C.up:C.down},
      areaStyle:{color:acc>=0?'rgba(229,72,77,.16)':'rgba(23,164,75,.16)'}}]
  }));
}

/* ========================================================================
   16 融資融券
   ======================================================================== */
function card16(){
  var m=P.margin, q=P.quote;
  if(!m){ el('t16sub').textContent='無資料'; emptyCard(el('w16'),'未取得融資融券資料','上櫃或部分標的無此欄位'); return; }
  el('t16sub').textContent=m.date+(m.date!==P.last_date?'（落後股價）':'');
  el('w16').className='stats';
  el('w16').innerHTML=[
    ['融資餘額', (m.margin_bal===null?'無資料':ni(Math.round(m.margin_bal))+' 張'), m.margin_chg, '張'],
    ['融券餘額', (m.short_bal===null?'無資料':ni(Math.round(m.short_bal))+' 張'), m.short_chg, '張'],
    ['量比', q.vratio===null?'—':nf(q.vratio)+' 倍', null, '']
  ].map(function(r){
    return '<div class="stat"><div class="sv">'+r[1]+'</div><div class="sl">'+r[0]+'</div>'+
      '<div class="sd '+cls(r[2])+'">'+(r[2]===null?(r[0]==='量比'?'對比20日均量':'增減資料不足'):arrow(r[2])+' 單日 '+sg(r[2],0)+' '+r[3])+'</div></div>';
  }).join('');
}

/* ========================================================================
   18 綜合研判
   ======================================================================== */
function card18(){
  var pl=P.plan, sc=P.scores, t=P.tech, cp=P.chip;
  var col={bull:C.up,mild:C.warn,neutral:C.ink2,bear:C.down}[pl.vclass]||C.ink2;
  el('v-txt').textContent=pl.verdict;
  el('v-txt').style.color=col;
  el('v-badges').innerHTML=[
    '綜合 '+(sc.overall===null?'—':nf(sc.overall,0)),
    t.trend_txt,
    cp.net5===null?('法人近5日不足 '+cp.coverage5+'/5日'):('近5日法人 '+sg(cp.net5,0)+' 張'),
    'ATR '+(t.atr_pct===null?'—':nf(t.atr_pct)+'%')
  ].map(function(s){return '<span class="badge">'+esc(s)+'</span>';}).join('');
  el('v-tab').innerHTML=[
    ['參考進場區', pl.entry_lo===null?'—':nf(pl.entry_lo)+' ~ '+nf(pl.entry_hi),'flat'],
    ['停損參考（收盤 −1×ATR 與近10日低點取低）', pl.stop===null?'—':nf(pl.stop),'down'],
    ['首目標（60日高點）', pl.target===null?'—':nf(pl.target),'up'],
    ['風險報酬比', pl.rr===null?'—':nf(pl.rr),'flat'],
    ['20日成交均價', nf(t.vwap20),'flat']
  ].map(function(r){ return '<tr><td>'+esc(r[0])+'</td><td class="'+r[2]+'">'+esc(r[1])+'</td></tr>';}).join('');
}

/* ========================================================================
   頁首 / 頁尾 / 資料表
   ======================================================================== */
function header(){
  var q=P.quote, sc=P.scores;
  el('h-code').textContent=P.code;
  el('h-name').textContent=P.name;
  txt('h-close',nf(q.close),cls(q.chg));
  txt('h-chg',arrow(q.chg)+' '+sg(q.chg),cls(q.chg));
  txt('h-chgp',sg(q.chg_pct)+'%',cls(q.chg));
  txt('h-open',nf(q.open)); txt('h-high',nf(q.high)); txt('h-low',nf(q.low));
  txt('h-trades',ni(q.trades)); txt('h-days',P.bars_count+' 日');
  el('h-quality').innerHTML=(P.avail.indicators_ready && P.scores.chip!==null && P.avail.margin_current && P.dividends&&P.dividends.available && P.bench&&P.bench.d20 && !(P.fetch_info&&P.fetch_info.warnings.length)?'資料齊全':'資料待補')+'<small>DATA STATUS</small>';
  txt('h-vol',nf(q.vol,1),'flat');
  txt('h-vr',q.vratio===null?'—':nf(q.vratio),'flat');
  txt('h-date',P.last_date,'flat');
  txt('h-score',sc.overall===null?'—':nf(sc.overall,0)+' / 100','flat');
  el('h-meta').innerHTML=[
    '資料來源：<b>'+esc(P.source)+'</b>',
    '區間：<b>'+P.range[0]+' ~ '+P.range[1]+'</b>（'+P.bars_count+' 個交易日）',
    '股價最新：<b>'+esc(P.last_date)+'</b>',
    '法人最新：<b>'+esc(P.avail.chip_latest||'無資料')+(P.chip.stale?'（落後股價）':'')+'</b>',
    '融資券最新：<b>'+esc(P.avail.margin_latest||'無資料')+(P.avail.margin_latest&&P.avail.margin_latest!==P.last_date?'（落後股價）':'')+'</b>',
    '相對強弱：<b>'+esc(P.bench?P.bench.name+'（雙方價格報酬、不含息）':'基準未取得')+'</b>',
    '除權息確認：<b>'+(!P.dividends||!P.dividends.available?'未完整取得':P.dividends.recent.length?'近60日有事件':'近60日無事件')+'</b>',
    '取得／要求：<b>'+P.bars_count+'／'+P.avail.need_days+' 日</b>',
    '產生時間：<b>'+P.generated+'</b>',
    P.fetch_info?'資料取得：<b>'+(P.fetch_info.mode==='demo'?'示範資料':P.fetch_info.warnings.length?'更新有缺漏':P.fetch_info.network_requests?'增量更新':'使用快取')+'</b>':''
  ].filter(Boolean).join('');
  if(P.fetch_info&&P.fetch_info.warnings.length){
    el('h-meta').innerHTML+='<span style="color:var(--warn)">'+esc(P.fetch_info.warnings.join(' '))+'</span>';
  }
  document.title=P.code+' '+P.name+' · '+((P.app&&P.app.title)||'台股戰略產生器');
}

function footer(){
  el('foot').innerHTML=
    '<b>怎麼讀這張圖。</b>所有分數（趨勢／動能／籌碼／量價／技術／綜合）都是把公開資料套進固定規則換算出來的 0–100 相對刻度，'+
    '<b>不是勝率，也不是對未來報酬的預測</b>。取不到資料的欄位一律顯示「無資料」，不以推估值填補。<br>'+
    '法人近5／20日按股價交易日對齊，任一日缺漏即不顯示該期間合計；兩期間完整才計籌碼分。累計線遇缺漏即停止。<br>'+
    '<b>0922b 計分口徑。</b>量價分＝50±35×min(量比/2,1)，依較前日收盤上漲／下跌決定正負，平盤為50；無成交量不計分。成交活躍度另列，ADX不加入總分。新版歷史回測也使用相同規則，不宜與舊版分數直接比較。RSI在全程平盤時採50。<br>'+
    '<b>指標定義。</b>MA=收盤簡單移動平均；KD=9日RSV，K/D 平滑係數 1/3；MACD=EMA12−EMA26，訊號線為其 EMA9；'+
    'RSI/ATR 採 Wilder 平滑，期數 14；20日成交均價以典型價 (H+L+C)/3 依成交量加權；'+
    '支撐／壓力取近 60 個交易日的最低／最高點；量比＝當日成交量 ÷ 20日均量。<br>'+
    '<b>布林通道。</b>20日收盤均值 ±2倍母體標準差；%B=(收盤−下軌)/(上軌−下軌)，零寬度時無法計算；寬度=(上軌−下軌)/中軌×100%。寬度在含當日近120筆有效值的百分位≤20才標示收斂（同值採中位名次）；不足139日不判定收斂。突破／跌破是當日收盤首次跨越對應軌道。未還原股價會受除權息影響，布林不納入綜合分。<br>'+
    '<b>費波南希回撤。</b>取目前顯示視窗內的最高點與最低點當波段：低點在前是上升波段，0% 在高點、100% 在低點；高點在前是下跌波段，方向相反。'+
    '各線＝波段幅度 × 23.6%／38.2%／50%／61.8%／78.6%（50% 不是費波南希比率，是慣例上一起畫的中點），淡色帶是 38.2%～61.8%。'+
    '改變分析天數，波段與各價位就會跟著變；波段是事後才看得出來的，今天的高低點明天可能被改寫。'+
    '這些比率是市場慣例，<b>沒有可靠的證據顯示價格會在這些位置轉折</b>，請把它當成「大家可能在看的價位」，不是支撐或壓力的保證。股價未還原，視窗內有除權息時波段幅度含缺口。<br>'+
    '<b>交易參數怎麼來的。</b>參考進場區＝收盤 ±0.25×ATR；停損＝收盤 −1×ATR 與近 10 日低點取較低者；'+
    '首目標＝60 日高點；風險報酬比＝(首目標 − 進場區上緣) ÷ (進場區上緣 − 停損)。這是規則換算，不是買賣建議。<br>'+
    '<b>顏色。</b>依台股慣例紅漲綠跌，並以 ▲▼ 符號、正負號與 K 棒空心／實心作為第二編碼；'+
    '紅綠對紅綠色盲不可分，可按上方「色盲友善配色」切換為橘／藍。<br>'+
    '<b>關於「主力」。</b>沒有券商分點進出資料就無法辨識實際主力，本圖不做這類推定。'+
    '三大法人買賣超只是公開的法人合計數字，不等於主力意圖。<br>'+
    '<b>免責。</b>本頁為公開資料的整理工具，不構成投資建議。投資決策請自行判斷並承擔風險。';
}

function rawtable(){
  var s=P.series, n=s.date.length;
  var cols=[['日期','date',null],['開','open',2],['高','high',2],['低','low',2],['收','close',2],
            ['量(張)','vol',1],['MA5','ma5',2],['MA20','ma20',2],['MA60','ma60',2],
            ['布林中軌','bb_mid',2],['布林上軌','bb_upper',2],['布林下軌','bb_lower',2],['布林%B','bb_percent_b',3],['布林寬度%','bb_width',2],['寬度百分位','bb_width_rank',1],['K','k',1],['D','d',1],['RSI','rsi',1],['ADX14','adx',2],['＋DI14','plus_di',2],['−DI14','minus_di',2],['DIF','dif',2],['OSC','osc',2],
            ['外資','chip_foreign',0],['投信','chip_trust',0],['自營','chip_dealer',0]];
  var h='<thead><tr>'+cols.map(function(c){return '<th>'+c[0]+'</th>';}).join('')+'</tr></thead>';
  var rows=[];
  for(var i=n-1;i>=0;i--){
    rows.push('<tr>'+cols.map(function(c){
      var v=s[c[1]][i];
      if(c[2]===null) return '<td>'+v+'</td>';
      return '<td>'+(v===null||v===undefined?'—':nf(v,c[2]))+'</td>';
    }).join('')+'</tr>');
  }
  el('rawtab').innerHTML=h+'<tbody>'+rows.join('')+'</tbody>';
}

/* ========================================================================
   啟動
   ======================================================================== */
var cardTemplates = null;
function drawAll(){
  var reopen=zoomed,restoreFocus=zoomFocus;
  closeZoom();
  charts.forEach(function(c){ c.dispose(); });
  charts=[];
  // 空狀態會替換圖卡內容；每次重畫先還原，讓下一檔有資料時可正常顯示。
  var ids=['w8','w15','w16'];
  if(!cardTemplates){
    cardTemplates=ids.map(function(id){var n=el(id);return {html:n.innerHTML,style:n.getAttribute('style'),cls:n.className};});
  }
  ids.forEach(function(id,i){
    var n=el(id), t=cardTemplates[i]; n.innerHTML=t.html; n.className=t.cls;
    if(t.style===null) n.removeAttribute('style'); else n.setAttribute('style',t.style);
  });
  readColors();
  if(strategyChart){strategyChart.dispose();strategyChart=null;}
  buildK1Controls();
  card01();card02();card03();card04();card05();card06();card07();card08();
  card09();card10();card11();card12();card13();card14();card15();card16();
  card17();card18();drawDMI();
  if(activeView==='bt') strategyView();
  document.querySelectorAll('[data-chart-png]').forEach(function(b){var n=el(b.dataset.chartPng);b.disabled=!n || !echarts.getInstanceByDom(n);});
  if(reopen&&reopen.isConnected&&!reopen.closest('[hidden]'))openZoom(reopen,restoreFocus);
}

function drawDMI(){
  var d=P.dmi||{},s=P.series;
  var strength=d.adx===null||d.adx===undefined?'資料不足':d.adx<20?'趨勢偏弱':d.adx<25?'過渡區':'趨勢較強';
  var direction=d.plus_di===null||d.plus_di===undefined||d.minus_di===null?'方向不足':d.plus_di>d.minus_di?'＋DI 較高':d.minus_di>d.plus_di?'−DI 較高':'方向持平';
  var v=P.volume_analysis||{};
  el('dmi-summary').textContent='ADX '+nf(d.adx,1)+' · ＋DI '+nf(d.plus_di,1)+' · −DI '+nf(d.minus_di,1)+' · '+strength+'／'+direction+'；量價：'+(v.state||'資料不足')+' · 量價分 '+nf(v.score,1)+' · 活躍度 '+nf(v.activity,1)+'（活躍度不加入總分）';
  mk('dmi-chart',Object.assign(base(),{
    legend:{data:['ADX14','＋DI14','−DI14'],top:0,textStyle:{color:C.ink2,fontSize:11}},
    tooltip:Object.assign(base().tooltip,{trigger:'axis'}),grid:{left:8,right:12,top:35,bottom:8,containLabel:true},
    xAxis:ax({type:'category',data:s.date,boundaryGap:false,splitLine:{show:false}}),yAxis:ax({type:'value',min:0,max:100}),
    series:[['adx','ADX14',C.s1],['plus_di','＋DI14',C.up],['minus_di','−DI14',C.down]].map(function(x){return {type:'line',name:x[1],data:s[x[0]]||[],symbol:'none',connectNulls:false,lineStyle:{color:x[2],width:2},itemStyle:{color:x[2]},markLine:x[0]==='adx'?{silent:true,symbol:'none',label:{fontSize:10,position:'insideEndTop',formatter:'{b}'},data:[{yAxis:20,name:'20'},{yAxis:25,name:'25'}]}:undefined};})
  }));
}

function backtestView(){
  var box=el('btwrap-body'); if(!box) return;
  var b=P.backtest;
  if(!b){ box.innerHTML='<p class="bt-note">歷史資料不足（至少需要約 75 個交易日），無法回測。</p>'; return; }
  function cell(s,key,unit){ var v=s[key]; if(v===null||v===undefined) return '<td>—</td>';
    var k=(key==='win')?'':(v>0?'up':v<0?'down':'flat');
    return '<td class="'+k+'">'+(key==='win'?nf(v,1):sg(v,2))+unit+'</td>'; }
  function row(r,base){
    return '<tr'+(base?' class="bt-base"':'')+'><th scope="row">'+esc(r.label)+'</th><td>'+r.days+'</td>'+
      b.horizons.map(function(h){ var s=r['h'+h];
        return '<td>'+s.n+'</td>'+cell(s,'mean','%')+cell(s,'median','%')+cell(s,'win','%'); }).join('')+'</tr>';
  }
  box.innerHTML=
    '<p class="bt-finding">'+esc(b.finding)+'</p>'+
    '<div class="scroll"><table class="raw bt-table"><thead><tr><th rowspan="2">當日綜合分</th><th rowspan="2">天數</th>'+
      b.horizons.map(function(h){return '<th colspan="4">之後 '+h+' 個交易日</th>';}).join('')+'</tr><tr>'+
      b.horizons.map(function(){return '<th>樣本</th><th>平均報酬</th><th>中位數</th><th>上漲比例</th>';}).join('')+
    '</tr></thead><tbody>'+b.rows.map(function(r){return row(r,false);}).join('')+row(b.baseline,true)+'</tbody></table></div>'+
    '<p class="bt-note">統計區間 '+esc(b.from||'—')+' ~ '+esc(b.to||'—')+'。做法：用和今天完全相同的規則，逐日重算過去每一天的綜合分'+
    '（每天只用當天以前的資料），再看那天收盤之後 5／10 個交易日的實際漲跌。</p>'+
    '<p class="bt-note"><b>讀這張表要注意：</b>只有這一檔、目前取得區間的資料；相鄰日子的 5／10 日報酬大幅重疊，實際獨立樣本遠少於表上的天數；'+
    '沒有計入手續費、交易稅與除權息。它能回答的是「這套規則分在這檔股票的這段期間有沒有跟後續漲跌同方向」，不能拿來預測未來。</p>';
}

function strategySettings(){return TWStrategy.settings(P&&P.strategy_settings);}
function fillStrategy(){
  var o=strategySettings();
  ['signal','threshold','hold','fee','tax','slip','start','end','segment'].forEach(function(k){el('st-'+k).value=o[k];});
  el('st-chip').checked=o.require_chip;
  el('strategy-status').textContent='';
}
function strategyView(){
  if(strategyChart){strategyChart.dispose();strategyChart=null;}
  fillStrategy();
  var target=el('strategy-result'), chart=el('strategy-chart'), trades=el('strategy-trades');
  if(!P.strategy_input){target.textContent='此報告沒有完整回測資料，請重新分析。';chart.hidden=true;trades.innerHTML='';el('st-csv').disabled=true;return;}
  try{strategyResult=TWStrategy.simulate(P.strategy_input,strategySettings());}
  catch(e){target.textContent=e.message;chart.hidden=true;trades.innerHTML='';el('st-csv').disabled=true;return;}
  var r=strategyResult,m=r.metrics,bm=r.baseline;
  el('st-csv').disabled=false;
  var items=[['淨報酬（含未平倉估值）',m?sg(m.net_return)+'%':'—'],['每日最大回落',m?nf(m.max_drawdown)+'%':'—'],
    ['已平倉 / 未平倉',r.trades.filter(function(t){return t.status==='closed';}).length+' / '+r.trades.filter(function(t){return t.status==='open';}).length],
    ['已平倉獲利比例',m&&m.win!==null?nf(m.win,1)+'%':'—'],['同股買入持有（扣成本）',bm?sg(bm.net_return)+'%':'—']];
  target.innerHTML='<p class="bt-note">實際區間 '+esc(r.from||'—')+' ～ '+esc(r.to||'—')+' · '+r.days+' 個交易日；僅使用這檔已取得的歷史資料，調參不會連網。</p>'+
    '<p class="bt-note">已套用：'+esc({score:'綜合分達門檻',bb:'布林首次突破上軌',both:'評分＋布林突破'}[r.settings.signal])+' · 門檻 '+r.settings.threshold+' · 持有 '+r.settings.hold+' 日 · 手續費 '+r.settings.fee+'% / 稅 '+r.settings.tax+'% / 滑價 '+r.settings.slip+'%</p>'+
    '<div class="strategy-metrics">'+items.map(function(x){return '<div><span>'+x[0]+'</span><b>'+x[1]+'</b></div>';}).join('')+'</div>'+
    (r.issues.length?'<p class="strategy-warning">'+esc(r.issues.join('；'))+'</p>':'')+
    (!r.trades.length?'<p class="bt-note">目前規則沒有產生可進場交易。</p>':'')+
    (r.trades.filter(function(t){return t.status==='closed';}).length<20?'<p class="bt-note">完成交易少於20筆，樣本有限；獲利比例不代表未來勝率。</p>':'')+
    (r.baseline_issues.length?'<p class="bt-note">買入持有基準未顯示：'+esc(r.baseline_issues.join('；'))+'</p>':'')+
    '<p class="bt-note">因開盤／成交量無效跳過 '+r.skipped_entry+' 次；最後一天尚無次日資料的訊號 '+r.unfilled_signals+' 次。圖表假設扣除當日清算成本，除權息影響的交易不提供報酬數值。</p>';
  chart.hidden=!r.curve.length;
  if(!chart.hidden){
    var option=Object.assign(base(),{legend:{top:0,data:['策略清算淨值','同股買入持有'],textStyle:{color:C.ink2}},
      grid:{left:50,right:20,top:35,bottom:30},tooltip:Object.assign(base().tooltip,{trigger:'axis'}),
      xAxis:ax({type:'category',data:r.curve.map(function(x){return x.date;}),boundaryGap:false,splitLine:{show:false}}),
      yAxis:ax({type:'value',scale:true}),series:[{name:'策略清算淨值',type:'line',symbol:'none',data:r.curve.map(function(x){return x.value;}),lineStyle:{color:C.s1,width:2},itemStyle:{color:C.s1}},
        {name:'同股買入持有',type:'line',symbol:'none',data:r.benchmark.map(function(x){return x.value;}),lineStyle:{color:C.muted,type:'dashed',width:1.5},itemStyle:{color:C.muted}}]});
    strategyChart=echarts.init(chart);strategyChart.setOption(scaleChartFonts(option));
  }
  trades.innerHTML='<table class="raw"><thead><tr>'+['訊號日','進場日','出場／估值日','狀態','訊號分數','實際持有日','進場價','出場／估值價','價格報酬','扣成本報酬','資料註記'].map(function(t){return '<th>'+t+'</th>';}).join('')+'</tr></thead><tbody>'+
    r.trades.map(function(t){return '<tr>'+[t.signal,t.entry,t.exit||t.valuation_date,t.status==='closed'?'已平倉':'未平倉估值',nf(t.score,1),t.held,nf(t.entry_price),nf(t.exit_price),t.price_return===null?'—':sg(t.price_return)+'%',t.net_return===null?'—':sg(t.net_return)+'%',t.events.length?'跨除權息 '+t.events.join('、'):t.quality.join('、')||(!P.strategy_input.events_confirmed?'除權息未確認':'')].map(function(v){return '<td>'+esc(v)+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table>';
}
function strategyCSV(){
  if(!P||!strategyResult)return;
  var r=strategyResult,o=r.settings;
  function field(v){return '"'+String(v===null||v===undefined?'':v).replace(/"/g,'""')+'"';}
  var rows=[['股票','策略','門檻','持有日','手續費%','賣出稅%','滑價%','要求法人完整','區間分段','起日','迄日','訊號日','進場日','出場／估值日','狀態','進場價','出場／估值價','扣成本報酬%','資料註記']];
  var prefix=[P.code,{score:'綜合分達門檻',bb:'布林首次突破上軌',both:'評分＋布林突破'}[o.signal],o.threshold,o.hold,o.fee,o.tax,o.slip,o.require_chip,o.segment,r.from,r.to];
  r.trades.forEach(function(t){rows.push(prefix.concat([t.signal,t.entry,t.exit||t.valuation_date,t.status,t.entry_price,t.exit_price,t.net_return,t.events.length?'跨除權息 '+t.events.join('、'):t.quality.join('、')||(!P.strategy_input.events_confirmed?'除權息未確認':'')]));});
  if(!r.trades.length)rows.push(prefix.concat(['','','','無交易','','','',r.issues.join('；')]));
  var url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(function(row){return row.map(field).join(',');}).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  var a=document.createElement('a');a.href=url;a.download=P.code+'_交易模擬.csv';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
}

function setView(view){
  closeZoom();
  activeView=view;
  el('dmi-panel').hidden=view!=='all'&&view!=='risk';
  var groups={risk:[2,5,9,12,14,18],kd:[1,6,11],macd:[1,7,11]};
  var grid=el('analysis-grid'); grid.dataset.view=view; grid.hidden=(view==='raw'||view==='bt');
  var bw=el('btwrap'); if(bw){ bw.hidden=view!=='bt'; if(view==='bt'&&P) backtestView(); }
  grid.querySelectorAll('.card').forEach(function(card,i){card.hidden=view!=='all' && (!groups[view] || groups[view].indexOf(i+1)<0);});
  el('tablewrap').hidden=view!=='raw';
  el('btn-tab').setAttribute('aria-pressed',String(view==='raw'));
  document.querySelectorAll('.analysis-tabs [data-view]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.view===view));});
  if(P) drawAll();
}
async function saveChart(id){
  if(!P) return;
  var status=el('chart-export-status');
  try{
    if(id==='k1' && (el('analysis-grid').hidden || el('k1').closest('.card').hidden)) setView('all');
    var node=el(id), chart=node&&echarts.getInstanceByDom(node);
    if(!chart) throw new Error('目前沒有可下載的圖表');
    var snapshot=P;
    var label=node.closest('.card,.dmi-panel').querySelector('h3').textContent.replace(/↓/g,'').trim();
    var src=chart.getDataURL({type:'png',pixelRatio:2,backgroundColor:C.surface});
    var img=new Image(); img.src=src; await img.decode();
    var canvas=document.createElement('canvas'); canvas.width=Math.max(img.width,900); canvas.height=img.height+112;
    var ctx=canvas.getContext('2d');ctx.fillStyle=C.surface;ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#edf0fa';ctx.font='bold 24px "Microsoft JhengHei",sans-serif';
    ctx.fillText(snapshot.code+' '+snapshot.name+' · '+snapshot.last_date+' · '+label,24,36,canvas.width-48);
    ctx.fillStyle='#99afd8';ctx.font='18px "Microsoft JhengHei",sans-serif';
    ctx.fillText(((snapshot.app&&snapshot.app.title)||'台股戰略產生器')+' | '+((snapshot.app&&snapshot.app.credit)||''),24,72,canvas.width-48);
    ctx.drawImage(img,Math.round((canvas.width-img.width)/2),100);
    var a=document.createElement('a');a.download=snapshot.code+'_'+snapshot.last_date+'_'+id+'.png';a.href=canvas.toDataURL('image/png');a.click();
    status.textContent='已產生 '+snapshot.code+' '+label+' PNG';
  }catch(e){status.textContent='圖表下載失敗：'+e.message;}
}

function bindOnce(){
  if(bindOnce.done) return; bindOnce.done=true;
  el('strategy-form').addEventListener('submit',function(e){
    e.preventDefault();if(!P)return;
    var o={require_chip:el('st-chip').checked};
    ['signal','threshold','hold','fee','tax','slip','start','end','segment'].forEach(function(k){o[k]=el('st-'+k).value;});
    try{P.strategy_settings=TWStrategy.settings(o);strategyView();}catch(err){el('strategy-status').textContent=err.message+'；圖表與下載沿用上次套用設定。';}
  });
  el('strategy-form').addEventListener('input',function(){el('strategy-status').textContent='設定尚未套用；圖表與下載沿用上次套用設定。';});
  el('st-reset').addEventListener('click',function(){if(P){P.strategy_settings=Object.assign({},TWStrategy.defaults);strategyView();}});
  el('st-csv').addEventListener('click',strategyCSV);
  var cb=el('btn-cb'), tb=el('btn-tab');
  if(cb) cb.addEventListener('click',function(){
    var on=document.documentElement.getAttribute('data-cb')==='1';
    document.documentElement.setAttribute('data-cb',on?'0':'1');
    this.setAttribute('aria-pressed',String(!on));
    if(P) drawAll();
  });
  if(tb) tb.addEventListener('click',function(){setView(activeView==='raw'?'all':'raw');});
  document.querySelectorAll('.analysis-tabs [data-view]').forEach(function(b){b.addEventListener('click',function(){setView(b.dataset.view);});});
  document.querySelectorAll('[data-chart-png]').forEach(function(b){b.addEventListener('click',function(){saveChart(b.dataset.chartPng);});});
  bindK1();
  el('btn-main-png').addEventListener('click',function(){saveChart('k1');});
  var tid;
  window.addEventListener('resize',function(){
    clearTimeout(tid);
    tid=setTimeout(function(){ resizeCharts(); },140);
  });
}

function render(payload){
  closeZoom();
  P = payload;
  if(typeof echarts==='undefined'){
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:12px 16px;background:#3a1d1d;color:#ffb4b4;font-size:calc(13px * var(--font-scale, 1))">'+
      'ECharts 沒有載入成功，圖表無法繪製。</div>');
    return;
  }
  bindOnce(); readColors(); header(); footer(); rawtable(); setView(activeView);
  el('chart-export-status').textContent='';
}


/* ========================================================================
   總體市場面板：美元兌台幣 + 台／美／日大盤（與個股無關，獨立渲染）
   ======================================================================== */
var macroResizeBound = false;
function renderMacro(m){
  var reopen=zoomed&&zoomed.matches('.macro-chart')?zoomed:null,restoreFocus=zoomFocus;
  if(reopen)closeZoom();
  latestMacroData=m;
  var host = el('macro'); if(!host) return;
  if(!macroResizeBound){                 // 還沒載入任何個股時 bindOnce() 尚未執行，這裡自己掛一個縮放監聽
    macroResizeBound = true;
    var mt; window.addEventListener('resize', function(){ clearTimeout(mt); mt = setTimeout(function(){ macroCharts.forEach(function(c){ c.resize(); }); }, 140); });
  }
  macroCharts.forEach(function(c){ c.dispose(); }); macroCharts = [];
  if(!C.ink) readColors();
  if(!m || !m.series){ host.hidden = true; return; }
  host.hidden = false;
  var idx = m.series.filter(function(s){ return s.kind==='index'; });
  var fx  = m.series.filter(function(s){ return s.kind==='fx'; })[0];
  function pct(ch){ return ch ? '<span class="'+cls(ch.pct)+'">'+sg(ch.pct)+'%</span>' : '<span class="flat">—</span>'; }
  function tile(s){
    if(!s.available) return '<div class="mtile off"><div class="mt-name">'+esc(s.name)+'</div><div class="mt-val">無資料</div>'+
      '<div class="mt-sub">'+esc(s.region||'')+'</div></div>';
    return '<div class="mtile"><div class="mt-name">'+esc(s.name)+(s.region?'<span>'+esc(s.region)+'</span>':'')+'</div>'+
      '<div class="mt-val">'+nf(s.latest, s.digits)+(s.unit?'<small> '+esc(s.unit)+'</small>':'')+'</div>'+
      '<div class="mt-row"><span>1日</span>'+pct(s.d1)+'<span>5日</span>'+pct(s.d5)+'<span>20日</span>'+pct(s.d20)+'</div>'+
      '<div class="mt-sub">'+esc(s.to)+' · '+esc(s.source||'')+(s.stale?' · 日期較舊（距今 '+s.age_days+' 個日曆日）':'')+'</div></div>';
  }
  el('macro-tiles').innerHTML = m.series.map(tile).join('');
  var meta = '顯示各序列最後 '+m.days+' 個交易日'+(m.latest_date?'，最新 '+m.latest_date:'')+'　·　產生 '+esc(m.generated)+
    (m.missing&&m.missing.length?'　·　取不到：'+esc(m.missing.join('、')):'')+
    (m.warnings&&m.warnings.length?'　·　'+esc(m.warnings.join('；')):'');
  el('macro-meta').innerHTML = meta;

  var palette = ['#3987e5', '#d95926', '#199e70', '#c98500'];    // 藍／橘／青綠／黃：固定的識別色，與漲跌紅綠無關，已驗證色覺缺陷可分
  var have = idx.filter(function(s){ return s.available && s.series.length > 1; });
  if(have.length){
    var opt = Object.assign(base(), {
      legend:{data:have.map(function(s){return s.name;}),top:0,left:0,itemWidth:14,itemHeight:2,textStyle:{color:C.ink2,fontSize:11}},
      grid:{left:8,right:12,top:26,bottom:8,containLabel:true},
      tooltip:Object.assign(base().tooltip,{trigger:'axis',formatter:function(ps){
        var o='<b>'+ps[0].axisValueLabel.slice(0,10)+'</b>';
        ps.forEach(function(p){ var raw=p.data[2]; o+='<br>'+p.marker+p.seriesName+'　'+nf(raw,0)+'　（'+sg(p.data[1]-100)+'%）'; });
        return o; }}),
      xAxis:ax({type:'time',splitNumber:4,splitLine:{show:false},axisLabel:{color:C.muted,fontSize:10,hideOverlap:true,formatter:function(v){return echarts.format.formatTime('MM-dd',v);}}}),
      yAxis:ax({type:'value',scale:true,axisLabel:{color:C.muted,fontSize:10,formatter:function(v){return sg(v-100,0)+'%';}}}),
      series:have.map(function(s,i){
        var base0 = s.series[0][1];
        return {name:s.name,type:'line',symbol:'none',lineStyle:{width:1.8,color:palette[i%palette.length]},itemStyle:{color:palette[i%palette.length]},
                data:s.series.map(function(p){ return [p[0], p[1]/base0*100, p[1]]; }),
                markLine:i===0?{silent:true,symbol:'none',lineStyle:{color:C.axis,type:'dashed'},label:{show:false},data:[{yAxis:100}]}:undefined};
      })
    });
    var node = el('macro-idx');
    if(node){ var ch = echarts.init(node,null,{renderer:'canvas'}); ch.setOption(scaleChartFonts(opt)); macroCharts.push(ch); }
  }else{ el('macro-idx').innerHTML = '<div class="empty">大盤指數暫無資料</div>'; }

  if(fx && fx.available && fx.series.length > 1){
    var opt2 = Object.assign(base(), {
      grid:{left:8,right:12,top:26,bottom:8,containLabel:true},
      tooltip:Object.assign(base().tooltip,{trigger:'axis',formatter:function(ps){ var p=ps[0];
        return '<b>'+p.axisValueLabel.slice(0,10)+'</b><br>'+p.marker+'美元兌台幣　'+nf(p.data[1],3); }}),
      xAxis:ax({type:'time',splitNumber:4,splitLine:{show:false},axisLabel:{color:C.muted,fontSize:10,hideOverlap:true,formatter:function(v){return echarts.format.formatTime('MM-dd',v);}}}),
      yAxis:ax({type:'value',scale:true,axisLabel:{color:C.muted,fontSize:10,formatter:function(v){return nf(v,2);}}}),
      series:[{name:fx.name,type:'line',symbol:'none',lineStyle:{width:1.8,color:C.s1},areaStyle:{color:'rgba(57,135,229,.12)'},data:fx.series}]
    });
    var node2 = el('macro-fx');
    if(node2){ var ch2 = echarts.init(node2,null,{renderer:'canvas'}); ch2.setOption(scaleChartFonts(opt2)); macroCharts.push(ch2); }
  }else{ el('macro-fx').innerHTML = '<div class="empty">匯率暫無資料</div>'; }
  if(reopen)openZoom(reopen,restoreFocus);
}

bindAppearance();

window.TWBoard = {
  render: render,
  renderMacro: renderMacro,
  strategySettings: strategySettings,
  resize: resizeCharts,
  payload: function(){ return P; },            // 名詞解釋用來顯示「目前這一檔」的數值
  macro: function(){ return latestMacroData; },
  kstate: function(){ return P ? lastK : null; },
  clear: function(){ closeZoom();charts.forEach(function(c){ c.dispose(); }); charts=[]; if(strategyChart){strategyChart.dispose();strategyChart=null;} P=null; }
};
})();
