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
  $('form').requestSubmit();
  var target=$('comparison');
  if(target) setTimeout(function(){target.scrollIntoView({behavior:'smooth',block:'start'});},60);
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

/* ---------- 族群輪動 ---------- */
var QCOLOR={'領漲':function(){return cssVar('--up');},'轉強':function(){return '#c98500';},'轉弱':function(){return '#9085e9';},'落後':function(){return cssVar('--down');}};
function sectors(){return (data?data.sectors:[]).filter(function(g){return !sectorKind||g.kind===sectorKind;});}
function drawSector(){
  var list=sectors();
  var node=$('mk-sector-chart');
  if(chart){chart.dispose();chart=null;}
  if(!data||!list.length){node.innerHTML='<div class="empty">'+(data?'這個分類沒有足夠的族群（每個族群至少 3 檔）':'尚未掃描')+'</div>';drawSectorTable();return;}
  node.innerHTML='';
  if(typeof echarts==='undefined'){node.textContent='圖表元件沒有載入';drawSectorTable();return;}
  var pts=list.filter(function(g){return ok(g.r5)&&ok(g.r20);});
  var xs=pts.map(function(g){return Math.abs(g.r20);}), ys=pts.map(function(g){return Math.abs(g.r5);});
  var xr=Math.max(2,Math.ceil(Math.max.apply(null,xs.concat([1]))*1.15)), yr=Math.max(2,Math.ceil(Math.max.apply(null,ys.concat([1]))*1.15));
  var ink=cssVar('--ink-2'), muted=cssVar('--muted'), grid=cssVar('--grid'), axis=cssVar('--axis');
  var scale=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'))||1;
  chart=echarts.init(node,null,{renderer:'canvas'});
  var corner=function(text,pos,color){return Object.assign({type:'text',silent:true,style:{text:text,fill:color,font:'600 '+Math.round(11*scale)+'px sans-serif',opacity:.85}},pos);};
  chart.setOption({
    animation:false, backgroundColor:'transparent',
    grid:{left:52,right:18,top:24,bottom:40},
    tooltip:{trigger:'item',backgroundColor:'#1b2130',borderColor:'#2c3446',textStyle:{color:'#fff',fontSize:12*scale},formatter:function(p){
      var g=p.data.g;
      return '<b>'+esc(g.name)+'</b>（'+esc(g.kind)+'，'+g.count+' 檔）<br>5 日 '+sg(g.r5)+'% · 20 日 '+sg(g.r20)+'% · 60 日 '+(ok(g.r60)?sg(g.r60)+'%':'—')+
        '<br>波動 '+(ok(g.vol)?nf(g.vol,0)+'%':'—')+' · 象限 '+esc(g.quadrant)+'<br>代表股：'+g.leaders.map(function(x){return esc(x.name);}).join('、');}},
    xAxis:{type:'value',min:-xr,max:xr,name:'20 日平均報酬（%）',nameLocation:'middle',nameGap:26,nameTextStyle:{color:muted,fontSize:11*scale},
           axisLabel:{color:muted,fontSize:10*scale,formatter:function(v){return (v>0?'+':'')+v+'%';}},splitLine:{lineStyle:{color:grid}},axisLine:{lineStyle:{color:axis}}},
    yAxis:{type:'value',min:-yr,max:yr,name:'5 日平均報酬（%）',nameLocation:'middle',nameGap:38,nameTextStyle:{color:muted,fontSize:11*scale},
           axisLabel:{color:muted,fontSize:10*scale,formatter:function(v){return (v>0?'+':'')+v+'%';}},splitLine:{lineStyle:{color:grid}},axisLine:{lineStyle:{color:axis}}},
    graphic:[corner('轉強 ↗ 短期發動',{left:62,top:30},'#c98500'),corner('領漲 ▲ 短中期皆強',{right:26,top:30},QCOLOR['領漲']()),
             corner('落後 ▽ 短中期皆弱',{left:62,bottom:48},QCOLOR['落後']()),corner('轉弱 ↘ 短期退潮',{right:26,bottom:48},'#9085e9')],
    series:[{type:'scatter',data:pts.map(function(g){
        var size=Math.max(9,Math.min(34,6+(ok(g.vol)?g.vol:30)*0.4));
        return {value:[g.r20,g.r5],g:g,name:g.name,symbolSize:activeSector===g.name?size+6:size,
          itemStyle:{color:QCOLOR[g.quadrant]?QCOLOR[g.quadrant]():muted,opacity:activeSector&&activeSector!==g.name?.45:.88,
                     borderColor:activeSector===g.name?'#fff':'rgba(0,0,0,.25)',borderWidth:activeSector===g.name?2:1}};}),
      label:{show:true,formatter:function(p){return p.data.g.name;},position:'top',color:ink,fontSize:10*scale},
      labelLayout:{hideOverlap:true},emphasis:{focus:'self',label:{fontWeight:'bold'}},
      markLine:{silent:true,symbol:'none',lineStyle:{color:axis,type:'dashed'},label:{show:false},data:[{xAxis:0},{yAxis:0}]}}]
  });
  chart.on('click',function(p){ if(p.data&&p.data.g) showMembers(p.data.g.name); });
  drawSectorTable();
}
function drawSectorTable(){
  var cols=[['name','族群'],['kind','類型'],['count','檔數'],['today','今日'],['r5','5 日'],['r20','20 日'],['r60','60 日'],['vol','波動'],['up_ratio','今日上漲家數'],['quadrant','象限'],['leaders','代表股']];
  var list=sectors().slice();
  var k=sectorSort.key;
  list.sort(function(a,b){var x=a[k],y=b[k];if(!ok(x))return 1;if(!ok(y))return -1;return (x-y)*sectorSort.dir;});
  var sortable={count:1,today:1,r5:1,r20:1,r60:1,vol:1,up_ratio:1};
  $('mk-sector-table').innerHTML='<thead><tr>'+cols.map(function(c){
      if(!sortable[c[0]]) return '<th scope="col">'+c[1]+'</th>';
      var on=c[0]===k;
      return '<th scope="col" aria-sort="'+(on?(sectorSort.dir<0?'descending':'ascending'):'none')+'"><button type="button" class="mk-sort" data-mk-sort="'+c[0]+'">'+c[1]+'<span>'+(on?(sectorSort.dir<0?'▼':'▲'):'↕')+'</span></button></th>';
    }).join('')+'</tr></thead><tbody>'+
    (list.length?list.map(function(g){
      var pct=function(v){return '<td class="'+cls(v)+'">'+(ok(v)?sg(v)+'%':'—')+'</td>';};
      return '<tr'+(g.name===activeSector?' class="selected"':'')+'><td><button type="button" class="mk-go" data-mk-sector="'+esc(g.name)+'">'+esc(g.name)+'</button></td>'+
        '<td>'+esc(g.kind)+'</td><td title="納入平均 '+g.count+' 檔，族群共 '+g.total+' 檔">'+g.count+(g.total>g.count?'<span class="flat"> / '+g.total+'</span>':'')+'</td>'+pct(g.today)+pct(g.r5)+pct(g.r20)+pct(g.r60)+
        '<td>'+(ok(g.vol)?nf(g.vol,0)+'%':'—')+'</td><td>'+(ok(g.up_ratio)?nf(g.up_ratio,0)+'%':'—')+'</td>'+
        '<td><span class="mk-q" data-q="'+esc(g.quadrant||'')+'">'+esc(g.quadrant||'—')+'</span></td>'+
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
  box.hidden=false;
  box.innerHTML='<div class="mk-members-head"><b>'+esc(g.name)+'</b><span>'+esc(g.kind)+' · '+g.count+' 檔納入平均'+(g.missing.length?' · 找不到：'+esc(g.missing.join('、')):'')+'</span>'+
    '<button type="button" class="btn" data-mk-analyse-sector="'+esc(g.name)+'">分析前 10 檔</button><button type="button" class="btn" data-mk-close-members>關閉</button></div>'+
    '<div class="mk-scroll"><table class="mk-table"></table></div>';
  var t=box.querySelector('table'); t.id='mk-member-table';
  stockTable('mk-member-table',list,[['code','股票'],['market','市場'],['close','收盤'],['chg_pct','漲跌幅'],['amount','成交值'],['vratio','量比'],['r5','5 日'],['r20','20 日'],['r60','60 日'],['streak','法人'],['tags','標記'],['act','']]);
  drawSector();
  box.scrollIntoView({behavior:'smooth',block:'nearest'});
}

/* ---------- 概念族群編輯 ---------- */
function themeRow(t){
  return '<div class="mk-theme"><input maxlength="20" value="'+esc(t.name)+'" aria-label="族群名稱" placeholder="族群名稱">'+
    '<textarea rows="1" aria-label="成員代號" placeholder="代號，用逗號分隔">'+esc((t.codes||[]).join(', '))+'</textarea>'+
    '<button type="button" class="btn" data-mk-theme-del>刪除</button></div>';
}
async function loadThemes(){
  try{var j=await api('/api/themes');themes=j.themes;$('mk-theme-state').textContent=j.custom?'（自訂）':'（預設範例）';}
  catch(e){$('mk-theme-msg').textContent=e.message;themes=[];}
  $('mk-theme-rows').innerHTML=themes.map(themeRow).join('');
}
function readThemes(){
  return Array.prototype.map.call($('mk-theme-rows').querySelectorAll('.mk-theme'),function(r){
    return {name:r.querySelector('input').value.trim(),codes:r.querySelector('textarea').value};
  }).filter(function(t){return t.name||t.codes.trim();});
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
  if(t==='sector'&&!themes.length) loadThemes();
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
  if(t.closest('[data-mk-theme-del]')){ t.closest('.mk-theme').remove(); $('mk-theme-msg').textContent='按「儲存族群」才會生效'; return; }
});
$('market').addEventListener('change',function(e){
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
$('mk-theme-add').addEventListener('click',function(){ $('mk-theme-rows').insertAdjacentHTML('beforeend',themeRow({name:'',codes:[]})); $('mk-theme-rows').lastElementChild.querySelector('input').focus(); });
$('mk-theme-save').addEventListener('click',async function(){
  try{ var j=await api('/api/themes',{themes:JSON.stringify(readThemes())}); themes=j.themes; $('mk-theme-state').textContent='（自訂）';
       $('mk-theme-rows').innerHTML=themes.map(themeRow).join(''); $('mk-theme-msg').textContent='已儲存 '+themes.length+' 個族群'; await loadMarket(); }
  catch(e){ $('mk-theme-msg').textContent=e.message; }
});
$('mk-theme-reset').addEventListener('click',async function(){
  try{ var j=await api('/api/themes/reset',{}); themes=j.themes; $('mk-theme-state').textContent='（預設範例）';
       $('mk-theme-rows').innerHTML=themes.map(themeRow).join(''); $('mk-theme-msg').textContent='已恢復預設；原本的自訂檔改名為 themes.json.bak'; await loadMarket(); }
  catch(e){ $('mk-theme-msg').textContent=e.message; }
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
