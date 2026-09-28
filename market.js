/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* ========================================================================
   市場掃描（20260925a）：選股清單、漲幅排行、熱門 ETF、族群輪動、到價警示、模擬持倉
   只在互動版載入。資料由 twserve.py 的 /api/market、/api/alerts、/api/portfolio 提供。
   ======================================================================== */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
if(!$('market')) return;

var data=null, tab='screens', screen='strong', rankKey='up', etfKey='amount', sectorKind='', sectorSort={key:'r5',dir:-1};
var selected=[], chart=null, activeSector=null, themes=[], alerts=[], paper=null, scanning=false;

/* ---------- 工具 ---------- */
function ok(v){return typeof v==='number'&&isFinite(v);}
function nf(v,d){if(!ok(v))return '—';d=d===undefined?2:d;return v.toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});}
function sg(v,d){return ok(v)?(v>0?'+':'')+nf(v,d):'—';}
function cls(v){return !ok(v)?'flat':v>0?'up':v<0?'down':'flat';}
function esc(s){return String(s===undefined||s===null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
function money(v){if(!ok(v))return '—';var a=Math.abs(v);return a>=1e8?nf(v/1e8,2)+' 億':a>=1e4?nf(v/1e4,0)+' 萬':nf(v,0);}
function cssVar(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
async function api(path,body){
  var r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  var j=await r.json();
  if(!r.ok||!j.ok) throw new Error(j.error||'請求失敗');
  return j;
}
function byCode(){var m={};(data?data.stocks:[]).forEach(function(s){m[s.code]=s;});return m;}
function marketOK(s){var m=$('mk-market').value;return !m||s.market===m;}
function minAmount(){return Number($('mk-amount').value);}
function note(text,warn){var n=$('mk-note');n.textContent=text||'';n.classList.toggle('warn',!!warn);}

/* 載入到下方 18 格：借用頁首表單，與手動輸入代號完全相同的流程 */
function analyse(codes){
  if(document.body.classList.contains('loading')){note('上一批分析還在進行，請稍候再點。',true);return;}
  $('f-code').value=codes.join(',');
  $('form').requestSubmit();          // 第一檔畫好後，頁面會自動捲到結果
}

/* ---------- 表格 ---------- */
var STOCK_COLS=[
  ['pick',''],['code','股票'],['market','市場'],['close','收盤'],['chg_pct','漲跌幅'],['vol','成交量（張）'],['vratio','量比'],
  ['r5','5 日'],['r20','20 日'],['streak','法人'],['scan_score','強勢分'],['tags','標記'],['act','']
];
function streakText(s){
  if(!ok(s.streak)||s.chip_date===null) return '<span class="flat">—</span>';
  var t=s.streak>0?'連買 '+s.streak+' 日':s.streak<0?'連賣 '+(-s.streak)+' 日':'持平';
  return '<span class="'+cls(s.streak)+'">'+t+'</span>'+(ok(s.net5)?'<small>5 日 '+sg(s.net5,0)+' 張</small>':'');
}
function stockRow(s,opts){
  opts=opts||{};
  var cells={
    pick:'<td class="mk-pick"><input type="checkbox" data-mk-pick="'+esc(s.code)+'" aria-label="勾選 '+esc(s.code)+'"'+(selected.indexOf(s.code)>=0?' checked':'')+'></td>',
    code:'<td class="mk-code"><button type="button" class="mk-go" data-mk-go="'+esc(s.code)+'" title="載入 18 格分析">'+esc(s.code)+'<small>'+esc(s.name)+'</small></button>'+
         (s.industry?'<span class="mk-ind">'+esc(s.industry)+'</span>':'')+'</td>',
    market:'<td>'+esc(s.market)+'</td>',
    close:'<td>'+nf(s.close)+'</td>',
    chg_pct:'<td class="'+cls(s.chg_pct)+'">'+sg(s.chg_pct)+'%</td>',
    vol:'<td>'+nf(s.vol,0)+'</td>',
    vratio:'<td>'+(ok(s.vratio)?nf(s.vratio)+' 倍':'—')+'</td>',
    r5:'<td class="'+cls(s.r5)+'">'+(ok(s.r5)?sg(s.r5)+'%':'—')+'</td>',
    r20:'<td class="'+cls(s.r20)+'">'+(ok(s.r20)?sg(s.r20)+'%':'—')+'</td>',
    r60:'<td class="'+cls(s.r60)+'">'+(ok(s.r60)?sg(s.r60)+'%':'—')+'</td>',
    amount:'<td>'+money(s.amount)+'</td>',
    streak:'<td class="mk-streak">'+streakText(s)+'</td>',
    scan_score:'<td>'+(ok(s.scan_score)?nf(s.scan_score,0):'—')+'</td>',
    tags:'<td class="mk-tags">'+(s.tags||[]).map(function(t){return '<span>'+esc(t)+'</span>';}).join('')+'</td>',
    act:'<td class="mk-act"><button type="button" class="btn" data-mk-buy="'+esc(s.code)+'">模擬買進</button><button type="button" class="btn" data-mk-alert="'+esc(s.code)+'">警示</button></td>'
  };
  return '<tr>'+(opts.cols||STOCK_COLS).map(function(c){return cells[c[0]]||'<td></td>';}).join('')+'</tr>';
}
function stockTable(id,list,cols,empty){
  cols=cols||STOCK_COLS;
  if(!data&&!list.length){ $(id).innerHTML='<tbody><tr><td class="mk-empty">尚未掃描：按右上角「開始掃描」取得上市櫃全部股票的資料。</td></tr></tbody>'; return; }
  $(id).innerHTML='<thead><tr>'+cols.map(function(c){return '<th scope="col">'+esc(c[1])+'</th>';}).join('')+'</tr></thead><tbody>'+
    (list.length?list.map(function(s){return stockRow(s,{cols:cols});}).join(''):'<tr><td colspan="'+cols.length+'" class="mk-empty">'+esc(empty||'目前沒有符合的股票')+'</td></tr>')+'</tbody>';
}

/* ---------- 選股清單 ---------- */
function drawScreens(){
  if(!data){stockTable('mk-screen-table',[],null,'尚未掃描');$('mk-screen-chips').innerHTML='';return;}
  var m=byCode();
  $('mk-screen-chips').innerHTML=data.screen_defs.map(function(d){
    var n=(data.screens[d.key]||[]).filter(function(c){return m[c]&&marketOK(m[c]);}).length;
    return '<button type="button" data-mk-screen="'+d.key+'" aria-pressed="'+(d.key===screen)+'">'+esc(d.label)+'<b>'+n+'</b></button>';
  }).join('');
  var def=data.screen_defs.filter(function(d){return d.key===screen;})[0]||data.screen_defs[0];
  $('mk-screen-rule').textContent='條件：'+def.rule+'。只列 20 日均成交值 ≥ '+money(data.min_amount)+' 的一般股票（不含 ETF），依條件強弱排序，最多 40 檔。';
  var list=(data.screens[def.key]||[]).map(function(c){return m[c];}).filter(function(s){return s&&marketOK(s);});
  stockTable('mk-screen-table',list,null,'今天沒有股票符合「'+def.label+'」');
  syncPick();
}
function syncPick(){
  var b=$('mk-analyse');
  b.disabled=!selected.length;
  b.textContent='分析勾選的股票（'+selected.length+'/10）';
}

/* ---------- 漲幅排行 ---------- */
var RANKS={
  up:{label:'今日漲幅',key:'chg_pct',dir:-1}, down:{label:'今日跌幅',key:'chg_pct',dir:1},
  amount:{label:'今日成交值',key:'amount',dir:-1}, vratio:{label:'量比（今日量 ÷ 20 日均量）',key:'vratio',dir:-1},
  r5:{label:'近 5 日漲幅',key:'r5',dir:-1}, r20:{label:'近 20 日漲幅',key:'r20',dir:-1}
};
function drawRank(){
  if(!data){stockTable('mk-rank-table',[],null,'尚未掃描');return;}
  var r=RANKS[rankKey], min=minAmount();
  var list=data.stocks.filter(function(s){return s.kind==='stock'&&marketOK(s)&&ok(s[r.key])&&(s.amount20||0)>=min;})
    .sort(function(a,b){return (a[r.key]-b[r.key])*r.dir;}).slice(0,50);
  $('mk-rank-rule').textContent=r.label+'前 50 名 · 一般股票 · 20 日均成交值 ≥ '+money(min)+'。漲跌幅以交易所公布的漲跌（對參考價）計算。';
  var cols=STOCK_COLS.slice();
  if(rankKey==='amount') cols.splice(5,1,['amount','成交值']);
  stockTable('mk-rank-table',list,cols);
}

/* ---------- 熱門 ETF ---------- */
function etfTags(s){
  var t=[], c=s.code, n=s.name||'';
  if(/B$/.test(c)) t.push('債券');
  if(/L$/.test(c)||/正2|正二/.test(n)) t.push('槓桿');
  if(/R$/.test(c)||/反1|反一/.test(n)) t.push('反向');
  if(/U$/.test(c)) t.push('期貨');
  return t;
}
function drawETF(){
  var cols=[['code','ETF'],['market','市場'],['close','收盤'],['chg_pct','漲跌幅'],['amount','成交值'],['vratio','量比'],['r5','5 日'],['r20','20 日'],['r60','60 日'],['tags','標記'],['act','']];
  if(!data){stockTable('mk-etf-table',[],cols,'尚未掃描');return;}
  var lev=$('mk-etf-lev').checked;
  var list=data.stocks.filter(function(s){return s.kind==='etf'&&marketOK(s)&&ok(s[etfKey]);})
    .map(function(s){return Object.assign({},s,{tags:etfTags(s)});})
    .filter(function(s){return lev||!(s.tags.indexOf('槓桿')>=0||s.tags.indexOf('反向')>=0);})
    .sort(function(a,b){return b[etfKey]-a[etfKey];}).slice(0,50);
  stockTable('mk-etf-table',list,cols,'沒有 ETF 資料');
}

/* ---------- 族群輪動（0928a）：四象限雷達、強弱熱力矩陣、排名變化、象限時間軸、動能加速度 ---------- */
var QCOLOR={'領漲':function(){return cssVar('--up');},'轉強':function(){return '#c98500';},'轉弱':function(){return '#9085e9';},'落後':function(){return cssVar('--down');}};
var QORDER=['領漲','轉強','轉弱','落後'];
var sectorView='radar', heatKey='day';
try{ var sv=localStorage.getItem('twboard.market.sectorView'); if(['radar','heat','rank','timeline','accel'].indexOf(sv)>=0) sectorView=sv; }catch(e){}
var VIEW_RULES={
  radar:'橫軸＝20 日平均報酬（中期動能），縱軸＝5 日平均報酬（短期動能），座標自動縮放；泡泡越大＝成員 20 日均成交值越大。右上＝領漲、左上＝轉強、右下＝轉弱、左下＝落後。點泡泡或族群名稱看成員與最近 10 天的移動軌跡。',
  heat:'每一列是一個族群、每一欄是一個交易日，顏色越紅越強、越綠越弱。可切換「當日漲跌」「5 日報酬」或「相對大盤」（族群當日平均漲跌減全市場平均）。列依最新一天排序。',
  rank:'依每天的 5 日平均報酬排名（第 1 名最強）。醒目標示最新排名前 8 的族群，其餘淡灰；滑鼠移到線上看排名變化，點線看成員。',
  timeline:'每一格是那一天所在的象限。可以看出族群從「落後 → 轉強 → 領漲 → 轉弱」的輪動節奏；需要 60 個交易日的掃描期間才有完整 20 天。',
  accel:'動能加速度＝今天的 5 日報酬 − 5 個交易日前的 5 日報酬（百分點）。正值代表短線動能正在變強、負值代表正在降溫；和目前漲跌方向一起看。'
};
function qOf(r5,r20){ if(!ok(r5)||!ok(r20)) return null; return r20>=0?(r5>=0?'領漲':'轉弱'):(r5>=0?'轉強':'落後'); }
function sectors(){return (data?data.sectors:[]).filter(function(g){return !sectorKind||g.kind===sectorKind;});}
function sdates(){ return (data&&data.sector_dates)||[]; }
/* 衍生：每天的象限、3 日內是否換象限、加速度 */
function derive(g){
  if(g._d) return g._d;
  var h=g.hist||{r5:[],r20:[],day:[]}, n=h.r5.length, qs=h.r5.map(function(v,i){return qOf(v,h.r20[i]);});
  var now=g.quadrant, prev=null;
  for(var k=n-2;k>=Math.max(0,n-4);k--){ if(qs[k]&&qs[k]!==now){ prev=qs[k]; break; } }
  var acc=(n>5&&ok(h.r5[n-1])&&ok(h.r5[n-6]))?Math.round((h.r5[n-1]-h.r5[n-6])*100)/100:null;
  g._d={qs:qs, changed:!!prev, prev:prev, accel:acc, fast:ok(acc)&&acc>=2};
  return g._d;
}
function chartScale(){ return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'))||1; }
function tipBase(scale){ return {backgroundColor:'rgba(16,20,28,.96)',borderColor:'rgba(255,255,255,.14)',textStyle:{color:'#fff',fontSize:12*scale},confine:true}; }
function setChartHeight(px){ var node=$('mk-sector-chart'); node.style.height=px?Math.round(px)+'px':''; }
function drawSector(){
  var list=sectors(), node=$('mk-sector-chart');
  document.querySelectorAll('[data-mk-view]').forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.mkView===sectorView));});
  $('mk-sector-rule').textContent=VIEW_RULES[sectorView];
  drawViewOpts();
  if(chart){chart.dispose();chart=null;}
  setChartHeight(0);
  $('mk-sector-legend').innerHTML='';
  if(!data||!list.length){node.innerHTML='<div class="empty">'+(data?'這個分類沒有足夠的族群（每個族群至少 3 檔）':'尚未掃描：按右上角「開始掃描」')+'</div>';drawSectorTable();return;}
  node.innerHTML='';
  if(typeof echarts==='undefined'){node.textContent='圖表元件沒有載入';drawSectorTable();return;}
  var fn={radar:drawRadar,heat:drawHeat,rank:drawRankChange,timeline:drawTimeline,accel:drawAccel}[sectorView]||drawRadar;
  var msg=fn(list);
  if(msg){ if(chart){chart.dispose();chart=null;} setChartHeight(0); node.innerHTML='<div class="empty">'+esc(msg)+'</div>'; }
  if(chart) chart.on('click',function(p){ var name=p.data&&p.data.g?p.data.g.name:(p.seriesName&&p.seriesType==='line'?p.seriesName:null); if(!name&&p.data&&p.data.name) name=p.data.name; if(name&&(data.sectors||[]).some(function(g){return g.name===name;})) showMembers(name); });
  drawSectorTable();
}
function drawViewOpts(){
  var box=$('mk-view-opts');
  if(sectorView!=='heat'){ box.innerHTML=''; return; }
  box.innerHTML='<span class="mk-hint">顏色代表</span><div class="mk-chips">'+[['day','當日漲跌'],['r5','5 日報酬'],['rel','相對大盤（當日）']].map(function(x){
    return '<button type="button" data-mk-heat="'+x[0]+'" aria-pressed="'+(heatKey===x[0])+'">'+x[1]+'</button>';}).join('')+'</div>';
}
function axisStyle(extra){
  var muted=cssVar('--muted'), grid=cssVar('--grid'), axis=cssVar('--axis'), s=chartScale();
  return Object.assign({axisLabel:{color:muted,fontSize:10*s},splitLine:{lineStyle:{color:grid}},axisLine:{lineStyle:{color:axis}},axisTick:{show:false},nameTextStyle:{color:muted,fontSize:11*s}},extra||{});
}
function pctFmt(v){return (v>0?'+':'')+v+'%';}

/* 四象限雷達 */
function drawRadar(list){
  var pts=list.filter(function(g){return ok(g.r5)&&ok(g.r20);});
  if(!pts.length) return '族群報酬資料不足';
  var xs=pts.map(function(g){return Math.abs(g.r20);}), ys=pts.map(function(g){return Math.abs(g.r5);});
  var xr=Math.max(2,Math.ceil(Math.max.apply(null,xs.concat([1]))*1.15)), yr=Math.max(2,Math.ceil(Math.max.apply(null,ys.concat([1]))*1.15));
  var trail=[], act=activeSector&&pts.filter(function(g){return g.name===activeSector;})[0];
  if(act&&act.hist){
    var h=act.hist, n=h.r5.length;
    for(var i=Math.max(0,n-10);i<n;i++) if(ok(h.r5[i])&&ok(h.r20[i])) trail.push([h.r20[i],h.r5[i],sdates()[i]]);
    trail.forEach(function(p){ xr=Math.max(xr,Math.ceil(Math.abs(p[0])*1.1)); yr=Math.max(yr,Math.ceil(Math.abs(p[1])*1.1)); });
  }
  var ink=cssVar('--ink-2'), scale=chartScale(), maxAmt=Math.max.apply(null,pts.map(function(g){return g.amount||0;}).concat([1]));
  var up=cssVar('--up'), down=cssVar('--down');
  chart=echarts.init($('mk-sector-chart'),null,{renderer:'canvas'});
  var corner=function(text,pos,color){return Object.assign({type:'text',silent:true,style:{text:text,fill:color,font:'700 '+Math.round(13*scale)+'px sans-serif',opacity:.95}},pos);};
  var tint=function(x0,y0,x1,y1,c){return [{xAxis:x0,yAxis:y0,itemStyle:{color:c}},{xAxis:x1,yAxis:y1}];};
  chart.setOption({
    animation:false, backgroundColor:'transparent',
    grid:{left:56,right:22,top:26,bottom:46},
    tooltip:Object.assign(tipBase(scale),{trigger:'item',formatter:function(p){
      if(p.seriesName==='軌跡') return esc(activeSector)+'<br>'+esc(p.data[2]||'')+'　5 日 '+sg(p.data[1])+'% · 20 日 '+sg(p.data[0])+'%';
      var g=p.data.g, d=derive(g);
      return '<b>'+esc(g.name)+'</b>（'+esc(g.kind)+'，'+g.count+' 檔）<br>5 日 '+sg(g.r5)+'% · 20 日 '+sg(g.r20)+'% · 60 日 '+(ok(g.r60)?sg(g.r60)+'%':'—')+
        '<br>象限 '+esc(g.quadrant)+(d.changed?'　<span style="color:#f2c94c">🔔 3 日內由「'+esc(d.prev)+'」轉入</span>':'')+
        '<br>動能加速度 '+(ok(d.accel)?sg(d.accel)+' 個百分點':'—')+' · 20 日均成交值 '+money(g.amount)+
        '<br>代表股：'+g.leaders.map(function(x){return esc(x.name);}).join('、');}}),
    xAxis:axisStyle({type:'value',min:-xr,max:xr,name:'20 日平均報酬（中期動能）· 座標自動縮放',nameLocation:'middle',nameGap:28,axisLabel:{color:cssVar('--muted'),fontSize:10*scale,formatter:pctFmt}}),
    yAxis:axisStyle({type:'value',min:-yr,max:yr,name:'5 日平均報酬（短期動能）',nameLocation:'middle',nameGap:40,axisLabel:{color:cssVar('--muted'),fontSize:10*scale,formatter:pctFmt}}),
    graphic:[corner('轉強 ↗ 短期發動',{left:66,top:32},'#e0a21b'),corner('領漲 ▲ 短中期皆強',{right:30,top:32},up),
             corner('落後 ▽ 短中期皆弱',{left:66,bottom:54},down),corner('轉弱 ↘ 短期退潮',{right:30,bottom:54},'#a79cf0'),
             {type:'text',right:30,bottom:78,silent:true,style:{text:data.latest_date||'',fill:'rgba(255,255,255,.07)',font:'800 '+Math.round(34*scale)+'px sans-serif'}}],
    series:[{type:'scatter',name:'族群',data:pts.map(function(g){
        var d=derive(g), size=Math.round(12+30*Math.sqrt((g.amount||0)/maxAmt)), on=activeSector===g.name;
        return {value:[g.r20,g.r5],g:g,name:g.name,symbolSize:on?size+6:size,
          itemStyle:{color:QCOLOR[g.quadrant]?QCOLOR[g.quadrant]():cssVar('--muted'),opacity:activeSector&&!on?.4:.9,
                     borderColor:on?'#fff':d.fast?'#f2c94c':'rgba(0,0,0,.35)',borderWidth:on?2.5:d.fast?3:1,
                     shadowBlur:d.changed?14:0,shadowColor:'rgba(242,201,76,.7)'},
          label:{color:d.changed?'#f2c94c':ink,fontWeight:d.changed||on?'bold':'normal'}};}),
      label:{show:true,formatter:function(p){return (derive(p.data.g).changed?'🔔 ':'')+p.data.g.name;},position:'top',fontSize:11*scale,
             textBorderColor:'rgba(10,13,20,.85)',textBorderWidth:2},
      labelLayout:{hideOverlap:true},emphasis:{focus:'self',label:{fontWeight:'bold'}},z:3,
      markArea:{silent:true,data:[tint(0,0,xr,yr,'rgba(229,72,77,.07)'),tint(-xr,0,0,yr,'rgba(224,162,27,.06)'),
                                   tint(-xr,-yr,0,0,'rgba(23,164,75,.07)'),tint(0,-yr,xr,0,'rgba(144,133,233,.07)')]},
      markLine:{silent:true,symbol:'none',lineStyle:{color:cssVar('--axis'),type:'dashed'},label:{show:false},data:[{xAxis:0},{yAxis:0}]}},
      {type:'line',name:'軌跡',data:trail,symbol:'circle',symbolSize:function(v,p){return p.dataIndex===trail.length-1?9:5;},z:4,
       lineStyle:{color:'#fff',width:1.6,type:'dashed',opacity:.8},itemStyle:{color:'#fff'},
       label:{show:true,formatter:function(p){return p.dataIndex===0?(p.data[2]||'').slice(5):'';},color:'#fff',fontSize:10*scale,position:'bottom'}}]
  });
  $('mk-sector-legend').innerHTML='<span><b class="mk-bell">🔔</b>3 日內剛換象限</span><span><i style="border:2px solid #f2c94c;width:12px;height:12px"></i>黃框＝動能加速（5 日報酬比 5 天前高 2 個百分點以上）</span>'+
    '<span><i style="background:'+up+'"></i>領漲</span><span><i style="background:#c98500"></i>轉強</span><span><i style="background:#9085e9"></i>轉弱</span><span><i style="background:'+down+'"></i>落後</span>'+
    (act?'<span>白色虛線＝'+esc(act.name)+' 最近 10 天的軌跡（起點標日期）</span>':'<span>點泡泡看成員與軌跡</span>');
}

/* 強弱熱力矩陣 */
function heatValue(g,i){
  var h=g.hist; if(!h) return null;
  if(heatKey==='r5') return h.r5[i];
  var v=h.day[i];
  if(heatKey==='rel'){ var m=data.market_hist&&data.market_hist.day[i]; return ok(v)&&ok(m)?Math.round((v-m)*100)/100:null; }
  return v;
}
function drawHeat(list){
  var ds=sdates(); if(ds.length<2) return '歷史天數不足';
  var last=ds.length-1;
  var rows=list.filter(function(g){return g.hist;}).slice().sort(function(a,b){var x=heatValue(a,last),y=heatValue(b,last);return (ok(y)?y:-1e9)-(ok(x)?x:-1e9);});
  var cells=[], mx=0;
  rows.forEach(function(g,r){ ds.forEach(function(_,i){ var v=heatValue(g,i); if(ok(v)){ mx=Math.max(mx,Math.abs(v)); cells.push([i,rows.length-1-r,v]); } }); });
  if(!cells.length) return '沒有可顯示的資料';
  mx=Math.max(1,Math.ceil(mx*0.8));
  var scale=chartScale(), rowH=Math.max(18,Math.round(19*scale));
  setChartHeight(Math.max(360,rows.length*rowH+110));
  chart=echarts.init($('mk-sector-chart'),null,{renderer:'canvas'});
  var names=rows.map(function(g){return g.name;}).reverse();
  var label=heatKey==='r5'?'5 日報酬':heatKey==='rel'?'相對大盤':'當日漲跌';
  chart.setOption({
    animation:false, backgroundColor:'transparent',
    grid:{left:12,right:18,top:14,bottom:62,containLabel:true},
    tooltip:Object.assign(tipBase(scale),{formatter:function(p){
      var g=rows[rows.length-1-p.data[1]], i=p.data[0];
      var rk=rows.map(function(x){return heatValue(x,i);}).filter(ok).sort(function(a,b){return b-a;}).indexOf(p.data[2])+1;
      return '<b>'+esc(g.name)+'</b>　'+esc(ds[i])+'<br>'+label+' '+sg(p.data[2])+'%'+(rk?'（當天第 '+rk+' 名）':'');}}),
    xAxis:axisStyle({type:'category',data:ds.map(function(d){return d.slice(5);}),splitLine:{show:false},axisLabel:{color:cssVar('--muted'),fontSize:10*scale,interval:ds.length>12?1:0}}),
    yAxis:axisStyle({type:'category',data:names,splitLine:{show:false},axisLabel:{color:cssVar('--ink-2'),fontSize:11*scale}}),
    visualMap:{min:-mx,max:mx,calculable:false,orient:'horizontal',left:'center',bottom:6,itemWidth:12,itemHeight:180,text:['強 +'+mx+'%','弱 −'+mx+'%'],
               textStyle:{color:cssVar('--muted'),fontSize:10*scale},inRange:{color:[cssVar('--down'),'#1b2230',cssVar('--up')]}},
    series:[{type:'heatmap',data:cells,itemStyle:{borderColor:'#0b0e14',borderWidth:1},emphasis:{itemStyle:{borderColor:'#fff',borderWidth:1.5}},
             label:{show:ds.length<=20&&rowH>=18,fontSize:9*scale,color:'rgba(255,255,255,.82)',formatter:function(p){return Math.abs(p.data[2])>=10?Math.round(p.data[2]):p.data[2].toFixed(1);}}}]
  });
  chart.on('click',function(p){ if(p.data) showMembers(rows[rows.length-1-p.data[1]].name); });
}

/* 排名變化 */
function dailyRanks(list){
  var ds=sdates(), out={};
  list.forEach(function(g){out[g.name]=[];});
  ds.forEach(function(_,i){
    var vals=list.filter(function(g){return g.hist&&ok(g.hist.r5[i]);}).sort(function(a,b){return b.hist.r5[i]-a.hist.r5[i];});
    list.forEach(function(g){ var r=vals.indexOf(g); out[g.name].push(r>=0?r+1:null); });
  });
  return out;
}
function drawRankChange(list){
  var ds=sdates(); if(ds.length<3) return '歷史天數不足';
  var ranks=dailyRanks(list), last=ds.length-1;
  var withRank=list.filter(function(g){return ranks[g.name].some(ok);});
  if(!withRank.length) return '5 日報酬資料不足';
  var top=withRank.filter(function(g){return ok(ranks[g.name][last]);}).sort(function(a,b){return ranks[a.name][last]-ranks[b.name][last];}).slice(0,8).map(function(g){return g.name;});
  if(activeSector&&top.indexOf(activeSector)<0) top.push(activeSector);
  var pal=['#ff6b6b','#ffa94d','#ffd43b','#69db7c','#4dabf7','#9775fa','#f783ac','#63e6be','#ffffff'];
  var scale=chartScale(), n=withRank.length;
  setChartHeight(Math.max(420,Math.min(760,n*16+80)));
  chart=echarts.init($('mk-sector-chart'),null,{renderer:'canvas'});
  var series=withRank.map(function(g){
    var k=top.indexOf(g.name), hot=k>=0;
    var col=hot?pal[k%pal.length]:'rgba(160,168,184,.28)';
    return {type:'line',name:g.name,data:ranks[g.name],connectNulls:false,symbol:hot?'circle':'none',symbolSize:5,z:hot?5:2,
      lineStyle:{width:hot?2.4:1,color:col},itemStyle:{color:col},emphasis:{focus:'series',lineStyle:{width:3.2}},
      endLabel:{show:hot,formatter:function(){return ranks[g.name][last]+'　'+g.name;},color:col,fontSize:11*scale,fontWeight:'bold'}};
  });
  chart.setOption({
    animation:false, backgroundColor:'transparent',
    grid:{left:46,right:170,top:16,bottom:34},
    tooltip:Object.assign(tipBase(scale),{trigger:'item',formatter:function(p){
      var r=ranks[p.seriesName], first=r.filter(ok)[0], now=r[last];
      var diff=ok(first)&&ok(now)?first-now:null;
      return '<b>'+esc(p.seriesName)+'</b><br>'+esc(ds[p.dataIndex])+' 第 '+p.data+' 名<br>'+esc(ds[0].slice(5))+' 第 '+(ok(first)?first:'—')+' 名 → 最新 第 '+(ok(now)?now:'—')+' 名'+
        (ok(diff)?'（'+(diff>0?'↑ 進步 '+diff:diff<0?'↓ 退步 '+(-diff):'持平')+'）':'');}}),
    xAxis:axisStyle({type:'category',data:ds.map(function(d){return d.slice(5);}),boundaryGap:false,splitLine:{show:false}}),
    yAxis:axisStyle({type:'value',inverse:true,min:1,max:n,interval:Math.max(1,Math.ceil(n/10)),name:'名次',nameLocation:'start',nameGap:12}),
    series:series
  });
  $('mk-sector-legend').innerHTML='<span>名次依 5 日平均報酬（1＝最強）· 右側是最新名次</span>';
}

/* 象限時間軸 */
function drawTimeline(list){
  var ds=sdates(); if(ds.length<2) return '歷史天數不足';
  var rows=list.filter(function(g){return g.hist;}).slice().sort(function(a,b){
    var qa=QORDER.indexOf(a.quadrant), qb=QORDER.indexOf(b.quadrant); if(qa!==qb) return qa-qb; return (ok(b.r5)?b.r5:-1e9)-(ok(a.r5)?a.r5:-1e9);});
  var cells=[], any=0;
  rows.forEach(function(g,r){ derive(g).qs.forEach(function(q,i){ if(q){ any++; cells.push([i,rows.length-1-r,QORDER.indexOf(q)]); } }); });
  var full=rows.length?derive(rows[0]).qs.filter(Boolean).length:0;
  if(!any) return '需要至少 21 個交易日才能判斷象限；請把掃描期間改成 60 個交易日後按「更新掃描」';
  var scale=chartScale(), rowH=Math.max(18,Math.round(19*scale));
  setChartHeight(Math.max(360,rows.length*rowH+110));
  chart=echarts.init($('mk-sector-chart'),null,{renderer:'canvas'});
  var names=rows.map(function(g){return g.name;}).reverse();
  var colors=QORDER.map(function(q){return QCOLOR[q]();});
  chart.setOption({
    animation:false, backgroundColor:'transparent',
    grid:{left:12,right:18,top:14,bottom:58,containLabel:true},
    tooltip:Object.assign(tipBase(scale),{formatter:function(p){
      var g=rows[rows.length-1-p.data[1]], i=p.data[0], h=g.hist;
      return '<b>'+esc(g.name)+'</b>　'+esc(ds[i])+'<br>象限 '+QORDER[p.data[2]]+'<br>5 日 '+sg(h.r5[i])+'% · 20 日 '+sg(h.r20[i])+'%';}}),
    xAxis:axisStyle({type:'category',data:ds.map(function(d){return d.slice(5);}),splitLine:{show:false},axisLabel:{color:cssVar('--muted'),fontSize:10*scale,interval:ds.length>12?1:0}}),
    yAxis:axisStyle({type:'category',data:names,splitLine:{show:false},axisLabel:{color:cssVar('--ink-2'),fontSize:11*scale}}),
    visualMap:{type:'piecewise',orient:'horizontal',left:'center',bottom:6,textStyle:{color:cssVar('--ink-2'),fontSize:11*scale},
               pieces:QORDER.map(function(q,i){return {value:i,label:q,color:colors[i]};})},
    series:[{type:'heatmap',data:cells,itemStyle:{borderColor:'#0b0e14',borderWidth:1.5},emphasis:{itemStyle:{borderColor:'#fff',borderWidth:1.5}}}]
  });
  chart.on('click',function(p){ if(p.data) showMembers(rows[rows.length-1-p.data[1]].name); });
  if(full<ds.length) $('mk-sector-legend').innerHTML='<span>目前掃描期間較短，只有最近 '+full+' 天能判斷象限（20 日報酬需要 21 個交易日）。</span>';
}

/* 動能加速度 */
function drawAccel(list){
  var rows=list.filter(function(g){return ok(derive(g).accel);}).sort(function(a,b){return derive(b).accel-derive(a).accel;});
  if(!rows.length) return '需要至少 11 個交易日才能計算動能加速度';
  var scale=chartScale(), rowH=Math.max(18,Math.round(19*scale));
  setChartHeight(Math.max(360,rows.length*rowH+70));
  chart=echarts.init($('mk-sector-chart'),null,{renderer:'canvas'});
  var up=cssVar('--up'), down=cssVar('--down'), names=rows.map(function(g){return g.name;}).reverse();
  var mx=Math.max.apply(null,rows.map(function(g){return Math.abs(derive(g).accel);}).concat([1]));
  var lim=Math.ceil(mx*1.12), st=lim<=4?1:lim<=10?2:lim<=24?5:10; lim=Math.ceil(lim/st)*st;
  chart.setOption({
    animation:false, backgroundColor:'transparent',
    grid:{left:12,right:60,top:14,bottom:30,containLabel:true},
    tooltip:Object.assign(tipBase(scale),{trigger:'item',formatter:function(p){
      var g=p.data.g, h=g.hist, n=h.r5.length;
      return '<b>'+esc(g.name)+'</b><br>動能加速度 '+sg(p.data.value)+' 個百分點<br>5 日報酬：5 天前 '+sg(h.r5[n-6])+'% → 今天 '+sg(h.r5[n-1])+'%<br>目前象限 '+esc(g.quadrant);}}),
    xAxis:axisStyle({type:'value',min:-lim,max:lim,interval:st,name:'百分點',axisLabel:{color:cssVar('--muted'),fontSize:10*scale,formatter:function(v){return (v>0?'+':'')+v;}}}),
    yAxis:axisStyle({type:'category',data:names,splitLine:{show:false},axisLabel:{color:cssVar('--ink-2'),fontSize:11*scale}}),
    series:[{type:'bar',barMaxWidth:14,data:rows.slice().reverse().map(function(g){var a=derive(g).accel;return {value:a,g:g,name:g.name,itemStyle:{color:a>=0?up:down,borderRadius:a>=0?[0,3,3,0]:[3,0,0,3]}};}),
             label:{show:true,position:'right',formatter:function(p){return (p.value>0?'+':'')+p.value;},color:cssVar('--ink-2'),fontSize:10*scale},
             markLine:{silent:true,symbol:'none',lineStyle:{color:cssVar('--axis')},label:{show:false},data:[{xAxis:0}]}}]
  });
  $('mk-sector-legend').innerHTML='<span><i style="background:'+up+'"></i>加速（短線轉強）</span><span><i style="background:'+down+'"></i>減速（短線降溫）</span><span>黃框泡泡（四象限雷達）＝加速度 ≥ +2</span>';
}

function drawSectorTable(){
  var cols=[['name','族群'],['kind','類型'],['count','檔數'],['today','今日'],['r5','5 日'],['r20','20 日'],['r60','60 日'],['vol','波動'],['up_ratio','今日上漲家數'],['quadrant','象限'],['accel','加速度'],['leaders','代表股']];
  var list=sectors().slice();
  var k=sectorSort.key;
  var val=function(g){return k==='accel'?derive(g).accel:g[k];};
  list.sort(function(a,b){var x=val(a),y=val(b);if(!ok(x))return 1;if(!ok(y))return -1;return (x-y)*sectorSort.dir;});
  var sortable={count:1,today:1,r5:1,r20:1,r60:1,vol:1,up_ratio:1,accel:1};
  $('mk-sector-table').innerHTML='<thead><tr>'+cols.map(function(c){
      if(!sortable[c[0]]) return '<th scope="col">'+c[1]+'</th>';
      var on=c[0]===k;
      return '<th scope="col" aria-sort="'+(on?(sectorSort.dir<0?'descending':'ascending'):'none')+'"><button type="button" class="mk-sort" data-mk-sort="'+c[0]+'">'+c[1]+'<span>'+(on?(sectorSort.dir<0?'▼':'▲'):'↕')+'</span></button></th>';
    }).join('')+'</tr></thead><tbody>'+
    (list.length?list.map(function(g){
      var d=derive(g);
      var pct=function(v){return '<td class="'+cls(v)+'">'+(ok(v)?sg(v)+'%':'—')+'</td>';};
      return '<tr'+(g.name===activeSector?' class="selected"':'')+'><td><button type="button" class="mk-go" data-mk-sector="'+esc(g.name)+'">'+esc(g.name)+'</button></td>'+
        '<td>'+esc(g.kind)+'</td><td title="納入平均 '+g.count+' 檔，族群共 '+g.total+' 檔">'+g.count+(g.total>g.count?'<span class="flat"> / '+g.total+'</span>':'')+'</td>'+pct(g.today)+pct(g.r5)+pct(g.r20)+pct(g.r60)+
        '<td>'+(ok(g.vol)?nf(g.vol,0)+'%':'—')+'</td><td>'+(ok(g.up_ratio)?nf(g.up_ratio,0)+'%':'—')+'</td>'+
        '<td><span class="mk-q" data-q="'+esc(g.quadrant||'')+'">'+esc(g.quadrant||'—')+'</span>'+(d.changed?' <span class="mk-bell" title="3 日內由「'+esc(d.prev)+'」轉入">🔔 由'+esc(d.prev)+'轉入</span>':'')+'</td>'+
        '<td class="mk-acc '+cls(d.accel)+'">'+(ok(d.accel)?sg(d.accel):'—')+'</td>'+
        '<td class="mk-leaders">'+g.leaders.map(function(x){return '<button type="button" class="mk-mini" data-mk-go="'+esc(x.code)+'">'+esc(x.name)+'</button>';}).join('')+'</td></tr>';
    }).join(''):'<tr><td colspan="'+cols.length+'" class="mk-empty">'+(data?'沒有族群資料':'尚未掃描')+'</td></tr>')+'</tbody>';
}
function showMembers(name){
  var g=(data?data.sectors:[]).filter(function(x){return x.name===name;})[0];
  activeSector=g?name:null;
  var box=$('mk-members');
  if(!g){box.hidden=true;return;}
  var m=byCode();
  var list=g.members.map(function(c){return m[c];}).filter(Boolean).sort(function(a,b){return (ok(b.r20)?b.r20:-1e9)-(ok(a.r20)?a.r20:-1e9);});
  var d=derive(g);
  box.hidden=false;
  box.innerHTML='<div class="mk-members-head"><b>'+esc(g.name)+'</b><span>'+esc(g.kind)+' · '+g.count+' 檔納入平均 · 象限 '+esc(g.quadrant)+(d.changed?'（3 日內由「'+esc(d.prev)+'」轉入）':'')+
    (ok(d.accel)?' · 加速度 '+sg(d.accel):'')+(g.missing.length?' · 找不到：'+esc(g.missing.join('、')):'')+'</span>'+
    '<button type="button" class="btn" data-mk-analyse-sector="'+esc(g.name)+'">分析前 10 檔</button><button type="button" class="btn" data-mk-close-members>關閉</button></div>'+
    '<div class="mk-scroll"><table class="mk-table"></table></div>';
  var t=box.querySelector('table'); t.id='mk-member-table';
  stockTable('mk-member-table',list,[['code','股票'],['market','市場'],['close','收盤'],['chg_pct','漲跌幅'],['amount','成交值'],['vratio','量比'],['r5','5 日'],['r20','20 日'],['r60','60 日'],['streak','法人'],['tags','標記'],['act','']]);
  drawSector();
  box.scrollIntoView({behavior:'smooth',block:'nearest'});
}

/* ---------- 自訂族群（每列一個族群；成分股可只填代號，自動帶入名稱） ---------- */
var themeNames={};
var CODE_RE=/^([1-9]\d{3}|00\d{2,4}[A-Z]?)$/i;
function nameOf(c){ var s=byCode()[c]; return (s&&s.name)||themeNames[c]||''; }
function parseCodes(text){
  var out=[];
  String(text||'').split(/[,，、;；\n]+/).forEach(function(item){
    var toks=item.trim().split(/\s+/).filter(Boolean); if(!toks.length) return;
    (toks.every(function(t){return CODE_RE.test(t);})?toks:toks.slice(0,1)).forEach(function(c){ c=c.toUpperCase(); if(out.indexOf(c)<0) out.push(c); });
  });
  return out;
}
function membersText(codes){ return codes.map(function(c){ var n=CODE_RE.test(c)?nameOf(c):''; return n?c+' '+n:c; }).join(', '); }
var TRASH='<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
function themeRow(t){
  return '<div class="mk-theme"><input class="mk-te-name" maxlength="20" value="'+esc(t.name)+'" aria-label="族群名稱" placeholder="族群名稱">'+
    '<input class="mk-te-codes" value="'+esc(membersText(t.codes||[]))+'" aria-label="成分股" placeholder="例如：2330, 2317 鴻海, 2454（只填代號也可以）">'+
    '<button type="button" class="mk-te-del" data-mk-theme-del aria-label="刪除這個族群" title="刪除這個族群">'+TRASH+'</button></div>';
}
function drawThemes(){ $('mk-theme-rows').innerHTML=themes.map(themeRow).join(''); }
function themeMsg(text,warn){ var m=$('mk-theme-msg'); m.textContent=text||''; m.classList.toggle('warn',!!warn); }
async function loadThemes(){
  try{var j=await api('/api/themes');themes=j.themes;themeNames=j.names||{};$('mk-theme-state').textContent=j.custom?'（自訂）':'（預設範例）';}
  catch(e){themeMsg(e.message,true);themes=[];}
  drawThemes();
}
function readThemes(){
  return Array.prototype.map.call($('mk-theme-rows').querySelectorAll('.mk-theme'),function(r){
    var raw=r.querySelector('.mk-te-codes').value;
    var codes=parseCodes(raw);
    return {name:r.querySelector('.mk-te-name').value.trim(),codes:codes.length?codes:raw};
  }).filter(function(t){return t.name||(typeof t.codes==='string'?t.codes.trim():t.codes.length);});
}
function openThemes(on){
  $('mk-themes').hidden=!on; $('mk-theme-open').setAttribute('aria-expanded',String(on));
  if(on&&!$('mk-theme-rows').children.length) loadThemes();
  if(on) $('mk-themes').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function exportThemes(){
  var list=readThemes().map(function(t){return {name:t.name,codes:typeof t.codes==='string'?parseCodes(t.codes):t.codes};});
  var d=new Date(), stamp=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  var blob=new Blob([JSON.stringify({app:'台股戰略產生器',kind:'themes',exported:d.toISOString().slice(0,10),themes:list},null,1)],{type:'application/json'});
  var url=URL.createObjectURL(blob), a=document.createElement('a');a.href=url;a.download='族群_'+stamp+'.json';document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1500);
  themeMsg('已匯出 '+list.length+' 個族群');
}
function importThemes(file){
  var rd=new FileReader();
  rd.onload=function(){
    try{
      var j=JSON.parse(String(rd.result).replace(/^﻿/,'')), list=Array.isArray(j)?j:(j&&j.themes);
      if(!Array.isArray(list)||!list.length) throw new Error('檔案裡沒有族群清單');
      themes=list.map(function(t){ if(!t||typeof t.name!=='string') throw new Error('族群格式不正確'); return {name:t.name.slice(0,20),codes:Array.isArray(t.codes)?t.codes.map(String):parseCodes(t.codes)}; });
      drawThemes(); themeMsg('已載入 '+themes.length+' 個族群，確認後按「儲存並重算」才會生效');
    }catch(e){ themeMsg('匯入失敗：'+e.message,true); }
  };
  rd.readAsText(file,'utf-8');
}

/* ---------- 警示 ---------- */
function drawAlerts(){
  var newCount=alerts.filter(function(a){return a.new;}).length;
  var b=$('mk-alert-badge'); b.hidden=!newCount; b.textContent=newCount;
  $('mk-alert-table').innerHTML='<thead><tr><th>股票</th><th>條件</th><th>最新</th><th>狀態</th><th></th></tr></thead><tbody>'+
    (alerts.length?alerts.map(function(a){
      var q=a.quote, cond=[];
      if(ok(a.above)) cond.push('≥ '+nf(a.above));
      if(ok(a.below)) cond.push('≤ '+nf(a.below));
      if(ok(a.pct)) cond.push('漲跌 ±'+nf(a.pct,1)+'%');
      return '<tr'+(a.new?' class="mk-hit"':'')+'><td class="mk-code"><button type="button" class="mk-go" data-mk-go="'+esc(a.code)+'">'+esc(a.code)+'<small>'+esc(q&&q.name||'')+'</small></button>'+(a.note?'<span class="mk-ind">'+esc(a.note)+'</span>':'')+'</td>'+
        '<td>'+esc(cond.join('、'))+'</td>'+
        '<td>'+(q?esc(q.date)+' 收 '+nf(q.close)+'<small>高 '+nf(q.high)+' · 低 '+nf(q.low)+' · <span class="'+cls(q.chg_pct)+'">'+sg(q.chg_pct)+'%</span> · '+esc(q.source)+'</small>':'<span class="flat">等待報價：掃描市場或分析這檔後會比對</span>')+'</td>'+
        '<td>'+(a.triggered?'<b class="mk-alert-on">'+(a.new?'● 新觸發':'已觸發')+'</b><small>'+esc(a.hits.join('；'))+'</small>':'<span class="flat">未觸發</span>')+'</td>'+
        '<td class="mk-act"><button type="button" class="btn" data-mk-alert-edit="'+esc(a.code)+'">修改</button><button type="button" class="btn" data-mk-alert-del="'+esc(a.code)+'">刪除</button></td></tr>';
    }).join(''):'<tr><td colspan="5" class="mk-empty">還沒有設定警示。可在上方輸入，或在任一清單按「警示」。</td></tr>')+'</tbody>';
}
async function loadAlerts(){ try{ alerts=(await api('/api/alerts')).alerts; }catch(e){ $('mk-al-msg').textContent=e.message; } drawAlerts(); }

/* ---------- 模擬持倉 ---------- */
function drawPaper(){
  var p=paper||{open:[],closed:[],summary:{positions:0}};
  $('mk-paper-count').textContent=p.open.length?'（'+p.open.length+'）':'';
  var s=p.summary;
  $('mk-paper-summary').innerHTML=[
    ['持倉',p.open.length+' 筆'+(s.priced<p.open.length?'（'+(p.open.length-s.priced)+' 筆待報價）':'')],
    ['成本',money(s.cost)],['市值（扣賣出成本）',money(s.value)],
    ['未實現損益','<span class="'+cls(s.unrealized)+'">'+sg(s.unrealized,0)+'</span>'+(ok(s.unrealized_pct)?' <small class="'+cls(s.unrealized_pct)+'">'+sg(s.unrealized_pct)+'%</small>':'')],
    ['已實現損益','<span class="'+cls(s.realized)+'">'+sg(s.realized,0)+'</span>']
  ].map(function(x){return '<div><span>'+x[0]+'</span><b>'+x[1]+'</b></div>';}).join('');
  $('mk-paper-table').innerHTML='<thead><tr><th>股票</th><th>買進日</th><th>買進價</th><th>張數</th><th>現價</th><th>成本</th><th>市值</th><th>損益</th><th>報酬</th><th>天數</th><th></th></tr></thead><tbody>'+
    (p.open.length?p.open.map(function(r){
      var q=r.quote;
      return '<tr><td class="mk-code"><button type="button" class="mk-go" data-mk-go="'+esc(r.code)+'">'+esc(r.code)+'<small>'+esc(r.name)+'</small></button></td>'+
        '<td>'+esc(r.date)+'</td><td>'+nf(r.price)+'</td><td>'+nf(r.lots,r.lots%1?3:0)+'</td>'+
        '<td>'+(q?nf(q.close)+'<small>'+esc(q.date)+'</small>':'<span class="flat">待報價</span>')+'</td>'+
        '<td>'+(ok(r.cost)?nf(r.cost,0):'—')+'</td><td>'+(ok(r.value)?nf(r.value,0):'—')+'</td>'+
        '<td class="'+cls(r.profit)+'">'+(ok(r.profit)?sg(r.profit,0):'—')+'</td><td class="'+cls(r.return_pct)+'">'+(ok(r.return_pct)?sg(r.return_pct)+'%':'—')+'</td>'+
        '<td>'+(ok(r.days)?r.days:'—')+'</td>'+
        '<td class="mk-act"><span class="mk-sell" data-id="'+esc(r.id)+'"><input inputmode="decimal" aria-label="賣出價" value="'+(q?q.close:'')+'" placeholder="賣出價"><input type="date" aria-label="賣出日期" value="'+(q?esc(q.date):'')+'">'+
        '<button type="button" class="btn" data-mk-sell="'+esc(r.id)+'">模擬賣出</button></span><button type="button" class="btn" data-mk-pdel="'+esc(r.id)+'">刪除</button></td></tr>';
    }).join(''):'<tr><td colspan="11" class="mk-empty">還沒有模擬持倉。可在上方輸入，或在清單、個股分析頁按「模擬買進」。</td></tr>')+'</tbody>';
  $('mk-closed-table').innerHTML='<thead><tr><th>股票</th><th>買進</th><th>賣出</th><th>張數</th><th>損益</th><th>報酬</th><th></th></tr></thead><tbody>'+
    (p.closed.length?p.closed.map(function(r){
      return '<tr><td class="mk-code"><button type="button" class="mk-go" data-mk-go="'+esc(r.code)+'">'+esc(r.code)+'<small>'+esc(r.name)+'</small></button></td>'+
        '<td>'+esc(r.date)+' · '+nf(r.price)+'</td><td>'+esc(r.exit_date)+' · '+nf(r.exit_price)+'</td><td>'+nf(r.lots,r.lots%1?3:0)+'</td>'+
        '<td class="'+cls(r.profit)+'">'+sg(r.profit,0)+'</td><td class="'+cls(r.return_pct)+'">'+sg(r.return_pct)+'%</td>'+
        '<td class="mk-act"><button type="button" class="btn" data-mk-cdel="'+esc(r.id)+'">刪除</button></td></tr>';
    }).join(''):'<tr><td colspan="7" class="mk-empty">還沒有已平倉紀錄</td></tr>')+'</tbody>';
}
async function loadPaper(){ try{ paper=(await api('/api/portfolio')).portfolio; }catch(e){ $('mk-pp-msg').textContent=e.message; } drawPaper(); }

/* ---------- 分頁與總繪製 ---------- */
function drawMeta(){
  if(!data){ $('mk-meta').textContent='尚未掃描'; return; }
  var c=data.counts;
  $('mk-meta').textContent='資料日期 '+data.latest_date+' · 上市 '+c['上市']+' 檔、上櫃 '+c['上櫃']+' 檔（含 ETF '+c.etf+'）· '+data.trading_days+' 個交易日 · '+
    (data.cached_only?'本機快取':'產生 '+data.generated);
  var w=[];
  if(!data.has_industry) w.push('產業別未取得（FinMind 股票清單），族群只顯示概念族群');
  if(data.chip_dates['上市']&&data.chip_dates['上市']<data.latest_date) w.push('上市法人最新 '+data.chip_dates['上市']+'，落後行情');
  if(!data.chip_dates['上櫃']) w.push('上櫃法人未取得，上櫃股票不列入法人條件');
  if(data.warnings&&data.warnings.length) w.push(data.warnings.slice(0,4).join(' ')+(data.warnings.length>4?' 等 '+data.warnings.length+' 則':''));
  if(data.cached_only) w.push('目前顯示本機快取的結果，按「更新掃描」取得最新一天');
  note(w.join('；'),w.length&&!data.cached_only);
}
function drawAll(){
  drawMeta();
  $('mk-scan').textContent=data?'更新掃描':'開始掃描';
  if(tab==='screens') drawScreens();
  if(tab==='rank') drawRank();
  if(tab==='etf') drawETF();
  if(tab==='sector') drawSector();
}
function setTab(t){
  tab=t;
  document.querySelectorAll('#market [data-mk-tab]').forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.mkTab===t));});
  document.querySelectorAll('#market [data-mk-panel]').forEach(function(p){p.hidden=p.dataset.mkPanel!==t;});
  if(t==='alerts') loadAlerts();
  if(t==='paper') loadPaper();
  if(t==='sector'&&!themes.length&&!$('mk-themes').hidden) loadThemes();
  drawAll();
}

/* ---------- 掃描 ---------- */
async function loadMarket(){
  try{ var j=await api('/api/market?min_amount='+minAmount()); data=j.data; }
  catch(e){ note(e.message,true); }
  if(!data) note('按「開始掃描」下載上市櫃全部股票的每日行情。第一次要逐日下載約 90 個交易日（60 日期間），為了不被證交所擋下，每個請求間隔約 2 秒，大約需要 3～4 分鐘；之後每天只補新的一天。');
  drawAll();
}
async function scan(){
  if(scanning) return;
  scanning=true; $('mk-scan').disabled=true;
  var box=$('mk-progress'); box.hidden=false; $('mk-bar').value=0; $('mk-prog-stage').textContent='送出掃描'; $('mk-prog-eta').textContent=''; $('mk-prog-detail').textContent='';
  var t0=Date.now();
  try{
    var id=(await api('/api/market/scan',{days:$('mk-days').value,min_amount:$('mk-amount').value})).job_id, fails=0;
    while(true){
      await new Promise(function(r){setTimeout(r,700);});
      var job;
      try{ job=(await api('/api/jobs/'+encodeURIComponent(id))).job; fails=0; }
      catch(e){ if(++fails>=4) throw new Error('掃描進度連線中斷，請重新整理頁面。'); continue; }
      var p=job.progress||[0,1];
      $('mk-bar').max=p[1]; $('mk-bar').value=p[0];
      $('mk-prog-stage').textContent=(job.stage||'處理中')+' · '+p[0]+' / '+p[1];
      $('mk-prog-detail').textContent=(job.detail||'')+' · 下載 '+(job.network_requests||0)+' 次、沿用快取 '+(job.cache_hits||0)+' 次';
      if(p[0]>3&&p[0]<p[1]){var sec=(Date.now()-t0)/1000/p[0]*(p[1]-p[0]);$('mk-prog-eta').textContent='約剩 '+(sec>90?Math.round(sec/60)+' 分鐘':Math.max(1,Math.round(sec))+' 秒');}
      if(job.status==='done'){ data=job.data; break; }
      if(job.status==='error') throw new Error(job.error||'市場掃描失敗');
    }
    box.hidden=true; drawAll(); loadAlerts(); if(tab==='paper') loadPaper(); else refreshPaperCount();
  }catch(e){ $('mk-prog-stage').textContent='掃描失敗'; $('mk-prog-eta').textContent=''; $('mk-prog-detail').textContent=e.message; note(e.message,true); diagnose(); }
  finally{ scanning=false; $('mk-scan').disabled=false; }
}
/* ---------- 連線檢查 ---------- */
async function diagnose(){
  var box=$('mk-diag'), btn=$('mk-diag-btn');
  box.hidden=false; btn.disabled=true;
  box.innerHTML='<h3>連線檢查中…</h3><p>逐一連線證交所、櫃買中心與 FinMind，每個最多等 12 秒。</p>';
  try{
    var y=document.getElementById('a-yahoo');
    var d=(await api('/api/diagnose'+(y&&y.checked?'?yahoo=1':''))).data;
    if(d.demo){ box.innerHTML='<h3>連線檢查</h3><p>示範模式不連網，沒有可檢查的項目。</p>'; return; }
    var bad=d.checks.filter(function(c){return !c.ok;});
    var hint='';
    if(bad.some(function(c){return /SSL 憑證/.test(c.result);})) hint='憑證驗證失敗：請先確認電腦日期時間正確；公司網路若有「SSL 檢查」的防火牆或防毒軟體（會替換網站憑證），需要請管理人員把 twse.com.tw、tpex.org.tw 設為例外。';
    else if(bad.some(function(c){return /找不到主機|代理|逾時/.test(c.result);})) hint='網路層連不上：請確認這台電腦能用瀏覽器開啟 www.twse.com.tw；公司網路可能需要代理伺服器設定或把這兩個網站加入白名單。';
    else if(bad.some(function(c){return /拒絕|中斷|HTTP 403/.test(c.result);})) hint='連線被擋：可能是防火牆、防毒軟體，或網站暫時限制查詢頻率；過 20～30 分鐘再試。';
    else if(bad.some(function(c){return /格式|不是 JSON/.test(c.result);})) hint='連得上但格式看不懂：請把這張表的截圖和程式資料夾裡的 market_debug.log 回報，以便修正解析方式。';
    box.innerHTML='<h3>連線檢查結果（查詢日期 '+esc(d.checks[0]?d.checks[0].date:'')+'）</h3><div class="mk-scroll"><table class="mk-table"><thead><tr><th>來源</th><th>主機</th><th>結果</th><th>HTTP</th><th>耗時</th></tr></thead><tbody>'+
      d.checks.map(function(c){return '<tr><td>'+esc(c.source)+'</td><td>'+esc(c.host)+'</td><td class="'+(c.ok?'ok':'bad')+'">'+(c.ok?'✓ ':'✗ ')+esc(c.result)+
        (c.head?'<small>回應開頭：'+esc(c.head)+'</small>':'')+'</td><td>'+(c.http||'—')+'</td><td>'+(c.ms/1000).toFixed(1)+' 秒</td></tr>';}).join('')+
      '</tbody></table></div><p>Python '+esc(d.python)+' · '+esc(d.openssl)+' · '+esc(d.os)+' · 代理設定：'+(d.proxy.length?esc(d.proxy.join('、')):'無')+
      ' · X.509 嚴格模式'+(d.x509_strict_off?'已關閉（仍驗證憑證）':'未關閉')+'</p>'+
      (hint?'<p><b>可能原因：</b>'+esc(hint)+'</p>':(bad.length?'':'<p>各來源都連得上。若掃描仍失敗，請再按一次「更新掃描」。</p>'));
  }catch(e){ box.innerHTML='<h3>連線檢查失敗</h3><p>'+esc(e.message)+'</p>'; }
  finally{ btn.disabled=false; }
}
$('mk-diag-btn').addEventListener('click',diagnose);

async function refreshPaperCount(){ try{ paper=(await api('/api/portfolio')).portfolio; $('mk-paper-count').textContent=paper.open.length?'（'+paper.open.length+'）':''; }catch(e){} }

/* ---------- 預填表單 ---------- */
function quoteOf(code){
  var s=byCode()[code]; if(s) return {close:s.close,name:s.name};
  var P=window.TWBoard&&TWBoard.payload&&TWBoard.payload();
  if(P&&P.code===code) return {close:P.quote.close,name:P.name,date:P.last_date};
  return null;
}
function prefillBuy(code){
  var q=quoteOf(code);
  $('mk-pp-code').value=code; $('mk-pp-price').value=q&&ok(q.close)?q.close:''; $('mk-pp-lots').value='1';
  $('mk-pp-date').value=(data&&data.latest_date)||(q&&q.date)||'';
  $('mk-pp-msg').textContent='確認價格與張數後按「模擬買進」';
  setTab('paper'); $('market').scrollIntoView({behavior:'smooth',block:'start'}); $('mk-pp-price').focus({preventScroll:true});
}
function prefillAlert(code){
  var a=alerts.filter(function(x){return x.code===code;})[0], q=quoteOf(code);
  $('mk-al-code').value=code;
  $('mk-al-above').value=a&&ok(a.above)?a.above:(q&&ok(q.close)?Math.round(q.close*1.1*100)/100:'');
  $('mk-al-below').value=a&&ok(a.below)?a.below:(q&&ok(q.close)?Math.round(q.close*0.9*100)/100:'');
  $('mk-al-pct').value=a&&ok(a.pct)?a.pct:''; $('mk-al-note').value=a?a.note||'':'';
  $('mk-al-msg').textContent=a?'修改後按「新增／更新警示」':'已預填收盤價 ±10%，可自行調整';
  setTab('alerts'); $('market').scrollIntoView({behavior:'smooth',block:'start'}); $('mk-al-above').focus({preventScroll:true});
}

/* ---------- 事件 ---------- */
$('market').addEventListener('click',function(e){
  var t=e.target, b;
  if((b=t.closest('[data-mk-tab]'))) return setTab(b.dataset.mkTab);
  if((b=t.closest('[data-mk-screen]'))){ screen=b.dataset.mkScreen; return drawScreens(); }
  if((b=t.closest('[data-mk-rank]'))){ rankKey=b.dataset.mkRank; document.querySelectorAll('[data-mk-rank]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));}); return drawRank(); }
  if((b=t.closest('[data-mk-etf]'))){ etfKey=b.dataset.mkEtf; document.querySelectorAll('[data-mk-etf]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));}); return drawETF(); }
  if((b=t.closest('[data-mk-kind]'))){ sectorKind=b.dataset.mkKind; document.querySelectorAll('[data-mk-kind]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));}); activeSector=null; $('mk-members').hidden=true; return drawSector(); }
  if((b=t.closest('[data-mk-sort]'))){ var k=b.dataset.mkSort; sectorSort={key:k,dir:sectorSort.key===k?-sectorSort.dir:-1}; return drawSectorTable(); }
  if((b=t.closest('[data-mk-sector]'))) return showMembers(b.dataset.mkSector);
  if(t.closest('[data-mk-close-members]')){ activeSector=null; $('mk-members').hidden=true; return drawSector(); }
  if((b=t.closest('[data-mk-analyse-sector]'))){
    var g=data.sectors.filter(function(x){return x.name===b.dataset.mkAnalyseSector;})[0];
    if(g) analyse(g.members.slice(0,10)); return;
  }
  if((b=t.closest('[data-mk-go]'))) return analyse([b.dataset.mkGo]);
  if((b=t.closest('[data-mk-buy]'))) return prefillBuy(b.dataset.mkBuy);
  if((b=t.closest('[data-mk-alert]'))) return prefillAlert(b.dataset.mkAlert);
  if((b=t.closest('[data-mk-alert-edit]'))) return prefillAlert(b.dataset.mkAlertEdit);
  if((b=t.closest('[data-mk-alert-del]'))){ api('/api/alerts/delete',{code:b.dataset.mkAlertDel}).then(function(j){alerts=j.alerts;drawAlerts();$('mk-al-msg').textContent='已刪除';}).catch(function(err){$('mk-al-msg').textContent=err.message;}); return; }
  if((b=t.closest('[data-mk-sell]'))){
    var box=b.closest('.mk-sell'), ins=box.querySelectorAll('input');
    api('/api/portfolio/sell',{id:b.dataset.mkSell,price:ins[0].value,date:ins[1].value}).then(function(j){paper=j.portfolio;drawPaper();$('mk-pp-msg').textContent='已模擬賣出';})
      .catch(function(err){$('mk-pp-msg').textContent=err.message;}); return;
  }
  if((b=t.closest('[data-mk-pdel]'))||(b=t.closest('[data-mk-cdel]'))){
    var which=b.dataset.mkPdel?'open':'closed';
    api('/api/portfolio/delete',{id:b.dataset.mkPdel||b.dataset.mkCdel,which:which}).then(function(j){paper=j.portfolio;drawPaper();$('mk-pp-msg').textContent='已刪除紀錄';})
      .catch(function(err){$('mk-pp-msg').textContent=err.message;}); return;
  }
  if(t.closest('[data-mk-theme-del]')){ t.closest('.mk-theme').remove(); themeMsg('已移除一列，按「儲存並重算」才會生效'); return; }
  if((b=t.closest('[data-mk-view]'))){ sectorView=b.dataset.mkView; try{localStorage.setItem('twboard.market.sectorView',sectorView);}catch(err){} return drawSector(); }
  if((b=t.closest('[data-mk-heat]'))){ heatKey=b.dataset.mkHeat; return drawSector(); }
});
$('market').addEventListener('change',function(e){
  var tc=e.target.closest('.mk-te-codes');
  if(tc){ var codes=parseCodes(tc.value); if(codes.length&&codes.every(function(c){return CODE_RE.test(c);})) tc.value=membersText(codes); return; }
  var c=e.target.closest('[data-mk-pick]');
  if(!c) return;
  var code=c.dataset.mkPick;
  if(c.checked){ if(selected.length>=10){ c.checked=false; note('一次最多勾選 10 檔',true); return; } if(selected.indexOf(code)<0) selected.push(code); }
  else selected=selected.filter(function(x){return x!==code;});
  syncPick();
});
$('mk-analyse').addEventListener('click',function(){ if(selected.length) analyse(selected.slice()); });
$('mk-scan').addEventListener('click',scan);
/* 收合：不常用時把整個區塊縮成一行，記在這台電腦的瀏覽器 */
function setCollapsed(on){
  $('market').classList.toggle('collapsed',on);
  $('mk-toggle').textContent=on?'展開':'收合';
  $('mk-toggle').setAttribute('aria-expanded',String(!on));
  try{ localStorage.setItem('twboard.market.collapsed',on?'1':'0'); }catch(e){}
  if(!on&&chart) setTimeout(function(){chart.resize();},30);
}
$('mk-toggle').addEventListener('click',function(){ setCollapsed(!$('market').classList.contains('collapsed')); });
try{ if(localStorage.getItem('twboard.market.collapsed')==='1') setCollapsed(true); }catch(e){}
$('mk-amount').addEventListener('change',loadMarket);
$('mk-market').addEventListener('change',drawAll);
$('mk-etf-lev').addEventListener('change',drawETF);
$('mk-theme-open').addEventListener('click',function(){ openThemes($('mk-themes').hidden); });
$('mk-theme-close').addEventListener('click',function(){ openThemes(false); $('mk-theme-open').focus(); });
$('mk-theme-add').addEventListener('click',function(){ $('mk-theme-rows').insertAdjacentHTML('beforeend',themeRow({name:'',codes:[]})); var r=$('mk-theme-rows').lastElementChild; r.scrollIntoView({block:'nearest'}); r.querySelector('input').focus(); });
$('mk-theme-export').addEventListener('click',exportThemes);
$('mk-theme-import').addEventListener('click',function(){ $('mk-theme-file').value=''; $('mk-theme-file').click(); });
$('mk-theme-file').addEventListener('change',function(){ if(this.files&&this.files[0]) importThemes(this.files[0]); });
$('mk-theme-save').addEventListener('click',async function(){
  try{ var j=await api('/api/themes',{themes:JSON.stringify(readThemes())}); themes=j.themes; themeNames=j.names||themeNames; $('mk-theme-state').textContent='（自訂）';
       drawThemes(); themeMsg('已儲存 '+themes.length+' 個族群，族群輪動已重新計算'); await loadMarket(); }
  catch(e){ themeMsg(e.message,true); }
});
var resetArmed=null;
$('mk-theme-reset').addEventListener('click',async function(){
  var b=this;
  if(!resetArmed){ b.textContent='確定還原？再按一次'; resetArmed=setTimeout(function(){resetArmed=null;b.textContent='↺ 還原預設';},4000); return; }
  clearTimeout(resetArmed); resetArmed=null; b.textContent='↺ 還原預設';
  try{ var j=await api('/api/themes/reset',{}); themes=j.themes; themeNames=j.names||themeNames; $('mk-theme-state').textContent='（預設範例）';
       drawThemes(); themeMsg('已恢復預設；原本的自訂檔改名為 themes.json.bak'); await loadMarket(); }
  catch(e){ themeMsg(e.message,true); }
});
$('mk-alert-form').addEventListener('submit',async function(e){
  e.preventDefault();
  try{ var j=await api('/api/alerts',{code:$('mk-al-code').value.trim().toUpperCase(),above:$('mk-al-above').value.trim(),below:$('mk-al-below').value.trim(),pct:$('mk-al-pct').value.trim(),note:$('mk-al-note').value.trim()});
       alerts=j.alerts; drawAlerts(); $('mk-al-msg').textContent='已儲存 '+$('mk-al-code').value.trim().toUpperCase()+' 的警示'; }
  catch(err){ $('mk-al-msg').textContent=err.message; }
});
$('mk-al-ack').addEventListener('click',async function(){
  var d=alerts.map(function(a){return a.quote&&a.quote.date;}).filter(Boolean).sort().pop();
  if(!d){ $('mk-al-msg').textContent='目前沒有觸發中的警示'; return; }
  try{ alerts=(await api('/api/alerts/ack',{date:d})).alerts; drawAlerts(); $('mk-al-msg').textContent='已標為已讀'; }catch(err){ $('mk-al-msg').textContent=err.message; }
});
$('mk-paper-form').addEventListener('submit',async function(e){
  e.preventDefault();
  var code=$('mk-pp-code').value.trim().toUpperCase(), q=quoteOf(code);
  try{ var j=await api('/api/portfolio/buy',{code:code,price:$('mk-pp-price').value.trim(),lots:$('mk-pp-lots').value.trim(),date:$('mk-pp-date').value,name:q&&q.name||''});
       paper=j.portfolio; drawPaper(); $('mk-pp-msg').textContent='已記錄 '+code+' 模擬買進'; }
  catch(err){ $('mk-pp-msg').textContent=err.message; }
});
/* 18 格上方的「模擬買進」「設定到價警示」 */
document.addEventListener('click',function(e){
  var b=e.target.closest('#btn-paper,#btn-alert'); if(!b) return;
  var P=window.TWBoard&&TWBoard.payload&&TWBoard.payload(); if(!P) return;
  if(b.id==='btn-paper') prefillBuy(P.code); else { loadAlerts().then(function(){prefillAlert(P.code);}); }
});
/* 分析完一檔股票後，警示與持倉的現價可能變了 */
var lastSeen=null;
new MutationObserver(function(){
  var P=window.TWBoard&&TWBoard.payload&&TWBoard.payload();
  var key=P?P.code+P.last_date:null;
  if(key&&key!==lastSeen){ lastSeen=key; loadAlerts(); if(tab==='paper') loadPaper(); }
}).observe($('h-code')||document.body,{childList:true,characterData:true,subtree:true});
var rt; window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(chart)chart.resize();},140);});

window.TWMarket={reload:loadMarket,scan:scan,setTab:setTab,data:function(){return data;}};
loadMarket(); loadAlerts(); refreshPaperCount();
})();
