/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* ========================================================================
   強力分析（1002a）：一檔股票的九個深入面向，每個分頁各自向 /api/power 取資料。
   只在互動版載入；資料取不到時照實顯示原因，不用推估值。
   ======================================================================== */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var dlg=$('power');
if(!dlg) return;

var TABS=[
  ['holders','🐋','大戶持股','pw-holders'],['risk','⚖️','風險指標卡','pw-risk'],['us','','美股連動','pw-us'],
  ['vp','📊','分價量','volume-profile'],['foreign','🌏','外資持股','pw-foreign'],['short','🩳','借券／當沖','pw-sbl'],
  ['margins','🏭','三率＋現金流','pw-margins'],['dividend','💰','填息','pw-fill'],['season','📅','季節性','pw-season']
];
var cacheMeta={}, requestController=null, settingsRevision=0;
var CACHE_MS=600000;
function taipeiDay(){ return new Date(Date.now()+8*3600000).toISOString().slice(0,10); }
var st={code:'',name:'',tab:'risk',cache:{},charts:[],req:0,vp:'120',usPick:null,us:''};
try{
  var saved=JSON.parse(localStorage.getItem('twboard.power')||'{}');
  if(saved.tab&&TABS.some(function(t){return t[0]===saved.tab;})) st.tab=saved.tab;
  if(typeof saved.us==='string') st.us=saved.us;
  if(saved.vp) st.vp=String(saved.vp);
}catch(e){}
function remember(){ try{ localStorage.setItem('twboard.power',JSON.stringify({tab:st.tab,us:st.us,vp:st.vp})); }catch(e){} }

/* ---------- 工具 ---------- */
function ok(v){return typeof v==='number'&&isFinite(v);}
function nf(v,d){if(!ok(v))return '—';d=d===undefined?2:d;return v.toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});}
function sg(v,d){return ok(v)?(v>0?'+':'')+nf(v,d):'—';}
function esc(s){return String(s===undefined||s===null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
function cls(v){return !ok(v)?'':v>0?'up':v<0?'down':'';}
function lots(v){ if(!ok(v)) return '—'; return Math.abs(v)>=10000?nf(v/10000,1)+' 萬':nf(v,0); }
function money(v){ if(!ok(v)) return '—'; var a=Math.abs(v); return a>=1e8?nf(v/1e8,2)+' 億':a>=1e4?nf(v/1e4,0)+' 萬':nf(v,0); }
function cssVar(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function scale(){ var v=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')); return v>0?v:1; }
var GOLD='#f2c94c', BLUE='#6da7ec', PURPLE='#a48bf0', TEAL='#3fb28b';
function tip(){ var k=scale(); return {backgroundColor:'rgba(16,20,28,.96)',borderColor:'rgba(255,255,255,.14)',textStyle:{color:'#fff',fontSize:12*k},confine:true}; }
function axisBase(){ var k=scale(); return {axisLine:{lineStyle:{color:cssVar('--axis')}},axisLabel:{color:cssVar('--muted'),fontSize:11*k},splitLine:{lineStyle:{color:cssVar('--grid')}}}; }
function legend(){ var k=scale(); return {bottom:0,left:0,icon:'roundRect',itemWidth:18,itemHeight:4,textStyle:{color:cssVar('--ink-2'),fontSize:11.5*k}}; }
function md(d){ return d?d.slice(5):''; }

function card(label,value,sub,klass){
  return '<div class="pw-card"><div class="pw-lb">'+label+'</div><div class="pw-v '+(klass||'')+'">'+value+'</div>'+
    (sub?'<div class="pw-s">'+sub+'</div>':'')+'</div>';
}
function unit(v,u){ return v+(v==='—'?'':'<small>'+u+'</small>'); }
function banner(h,sub,help){
  if(!h) return '';
  return '<div class="pw-banner tone-'+esc(h.tone||'neutral')+'">'+
    (h.label?'<b class="pw-level">'+esc(h.label)+'</b>':'')+'<span class="pw-btxt">'+esc(h.text)+'</span>'+
    (help?'<button type="button" class="pw-help pw-q" data-glossary-open="'+help+'" title="這一頁的名詞解釋" aria-label="這一頁的名詞解釋">?</button>':'')+
    (sub?'<span class="pw-bsub">'+sub+'</span>':'')+'</div>';
}
function empty(reason,extra){
  return '<div class="pw-empty"><b>這一項目前沒有可用的資料</b>'+esc(reason||'取不到資料')+(extra||'')+'</div>';
}
function kv(label,value,note,klass){
  return '<div class="pw-kv"><span>'+label+'</span><b class="pw-num '+(klass||'')+'">'+value+'</b>'+(note?'<small>'+note+'</small>':'')+'</div>';
}
function chartBox(title,id,klass,extra){
  return '<div class="pw-box"><h4>'+title+'</h4>'+(extra||'')+'<div class="pw-chart '+(klass||'')+'" id="'+id+'"></div></div>';
}
function makeChart(id,opt){
  var el=$(id); if(!el||!window.echarts) return null;
  var c=echarts.init(el,null,{renderer:'canvas'});
  c.setOption(opt); st.charts.push(c); return c;
}
function dispose(){ st.charts.forEach(function(c){ try{c.dispose();}catch(e){} }); st.charts=[]; }
window.addEventListener('resize',function(){ st.charts.forEach(function(c){ try{c.resize();}catch(e){} }); });

/* 雙軸折線：左軸一條（或多條），右軸股價 */
function dualLine(id,dates,left,rightName,right,leftUnit,rightDigits){
  var k=scale(), ax=axisBase();
  var series=left.map(function(s){ return {name:s.name,type:'line',data:s.data,showSymbol:false,connectNulls:true,
      lineStyle:{width:2,color:s.color},itemStyle:{color:s.color},areaStyle:s.area?{color:s.area}:undefined,yAxisIndex:0}; });
  if(right) series.push({name:rightName,type:'line',data:right,showSymbol:false,connectNulls:true,yAxisIndex:1,
      lineStyle:{width:2,color:GOLD},itemStyle:{color:GOLD}});
  return makeChart(id,{
    animation:false,grid:{left:54,right:58,top:18,bottom:46},legend:legend(),
    tooltip:Object.assign(tip(),{trigger:'axis'}),
    xAxis:Object.assign({type:'category',data:dates,boundaryGap:false},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:md},splitLine:{show:false}}),
    yAxis:[Object.assign({type:'value',scale:true},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:function(v){return nf(v,leftUnit==='%'?1:0)+(leftUnit||'');}}}),
           Object.assign({type:'value',scale:true},ax,{splitLine:{show:false},axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:function(v){return nf(v,rightDigits===undefined?1:rightDigits);}}})],
    series:series
  });
}

/* ---------- 分頁：大戶持股 ---------- */
function rHolders(d){
  var h='';
  h+=banner(d.headline,'資料日期 '+esc(d.date)+' · '+esc(d.holder_source)+' · 共 '+d.weeks+' 週','pw-holders');
  h+='<div class="pw-cards">'+
    card('🐋 千張大戶持股',unit(nf(d.big1000),'%'),ok(d.ch1)?'1 週 '+sg(d.ch1)+' pt'+(ok(d.ch4)?' · 4 週 '+sg(d.ch4)+' pt':''):esc(d.date)+' 當週','blue')+
    card('400 張以上',unit(nf(d.big400),'%'),ok(d.b400_ch4)?'4 週 '+sg(d.b400_ch4)+' pt':'持股 400 張以上的股東','purple')+
    card('散戶（50 張以下）',unit(nf(d.retail),'%'),ok(d.retail_ch4)?'4 週 '+sg(d.retail_ch4)+' pt':'持股 50 張以下的股東')+
    card('股東人數',unit(nf(d.people,0),'人'),ok(d.people_ch4)?'4 週 '+sg(d.people_ch4,1)+'%（減少＝籌碼集中）':'集保戶數')+
    card('千張大戶人數',unit(nf(d.big1000_people,0),'人'),'持股超過 1,000 張')+
    card('平均每人持股',unit(nf(d.avg_lots,1),'張'),'集保總股數 ÷ 股東人數')+'</div>';
  if(d.weeks>1) h+=chartBox('千張大戶與 400 張以上持股比率 vs 股價（每週）','pw-c1');
  if(d.distribution) h+=chartBox('持股分級分布（'+esc(d.date)+'，占集保庫存比例）','pw-c2','short');
  h+='<p class="pw-note">集保戶股權分散表每週一份（週五資料，隔週初公布）。'+
    (d.weeks<=1?'免費的集保開放資料只提供最新一週；程式每次開啟會自動記下全市場摘要，幾週後就能看大戶增減趨勢。填入 FinMind 贊助會員 Token 可直接看過去一年。':'')+'</p>';
  return {html:h,after:function(){
    var c=d.chart;
    if(d.weeks>1) dualLine('pw-c1',c.date,[{name:'千張大戶 %',data:c.big1000,color:BLUE},{name:'400 張以上 %',data:c.big400,color:PURPLE}],'收盤價',c.close,'%');
    if(d.distribution){
      var k=scale(), ax=axisBase();
      makeChart('pw-c2',{animation:false,grid:{left:54,right:20,top:14,bottom:60},tooltip:Object.assign(tip(),{trigger:'axis',
          formatter:function(p){ var x=d.distribution[p[0].dataIndex]; return esc(x.level)+'<br>占比 '+nf(x.pct)+'%<br>人數 '+nf(x.people,0)+' 人'; }}),
        xAxis:Object.assign({type:'category',data:d.distribution.map(function(x){return x.level;})},ax,{axisLabel:{color:cssVar('--muted'),fontSize:10*k,rotate:35}}),
        yAxis:Object.assign({type:'value'},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}}),
        series:[{type:'bar',data:d.distribution.map(function(x,i){ return {value:x.pct,itemStyle:{color:i>=14?BLUE:i>=11?PURPLE:i<8?'#5d6780':'#7f8aa6',borderRadius:[3,3,0,0]}}; })}]});
    }
  }};
}

/* ---------- 分頁：風險指標卡 ---------- */
function rRisk(d){
  var h='';
  var sub='區間 '+esc(d.from)+' ～ '+esc(d.to)+'（'+d.days+' 個交易日）· 無風險利率 '+nf(d.rf_pct,1)+'% · Beta 對比'+(d.market==='tpex'?'櫃買指數':'加權指數');
  h+=banner(d.headline,sub,'pw-risk');
  h+='<div class="pw-panels">'+
    '<div class="pw-panel"><h4>報酬與效率</h4>'+
      kv('年化報酬',sg(d.annual_return)+'%','',cls(d.annual_return))+
      kv('夏普值',nf(d.sharpe),'每承擔 1 單位波動換到的超額報酬；&gt;1 佳、&lt;0 差',ok(d.sharpe)?(d.sharpe>=1?'good':d.sharpe<0?'crit':''):'')+
      kv('索提諾',nf(d.sortino),'只計下跌波動的夏普值',ok(d.sortino)?(d.sortino>=1?'good':d.sortino<0?'crit':''):'')+
      kv('卡瑪比',nf(d.calmar),'年化報酬 ÷ 最大回撤',ok(d.calmar)?(d.calmar>=1?'good':d.calmar<0?'crit':''):'')+
      kv('上漲日比例',nf(d.up_ratio,1)+'%')+'</div>'+
    '<div class="pw-panel"><h4>波動與市場敏感度</h4>'+
      kv('年化波動率',nf(d.volatility,1)+'%','台股個股常見 25%–45%',ok(d.volatility)?(d.volatility>45?'crit':d.volatility>25?'warn':'good'):'')+
      kv('Beta',nf(d.beta),'Beta 1.2 ＝ 大盤漲跌 1%，它平均漲跌 1.2%','warn')+
      kv('與大盤相關',nf(d.correlation))+
      kv('周轉率（日均）',ok(d.turnover)?nf(d.turnover,2)+'%':'--',ok(d.turnover)?'成交股數 ÷ 發行股數':'取不到發行股數')+'</div>'+
    '<div class="pw-panel"><h4>下檔風險</h4>'+
      kv('最大回撤',nf(d.max_drawdown,1)+'%',esc(d.mdd_peak)+' 高點 → '+esc(d.mdd_trough)+' 低點','down')+
      kv('目前距高點',nf(d.from_high,1)+'%','','down')+
      kv('單日 VaR 95%',nf(d.var95)+'%','20 天裡約有 1 天會跌超過這個幅度','down')+
      kv('CVaR 95%',nf(d.cvar95)+'%','最差 5% 日子的平均跌幅','down')+'</div></div>';
  h+=chartBox('股價與水下回撤曲線','pw-c1','tall');
  h+='<p class="pw-note">報酬、波動、回撤都以日報酬計算，除權息日改用參考價，不會把除息當成下跌；年化以一年 252 個交易日換算。VaR／CVaR 是歷史模擬法，不代表未來。</p>';
  return {html:h,after:function(){
    var c=d.chart, k=scale(), ax=axisBase();
    makeChart('pw-c1',{animation:false,grid:{left:54,right:58,top:18,bottom:46},legend:legend(),tooltip:Object.assign(tip(),{trigger:'axis'}),
      xAxis:Object.assign({type:'category',data:c.date,boundaryGap:false},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:md},splitLine:{show:false}}),
      yAxis:[Object.assign({type:'value',scale:true},ax),Object.assign({type:'value',max:4,min:function(v){return Math.floor(v.min/5)*5-4;}},ax,{splitLine:{show:false},axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}})],
      series:[{name:'收盤價（左軸）',type:'line',data:c.close,showSymbol:false,lineStyle:{width:2,color:'#7fd6ea'},itemStyle:{color:'#7fd6ea'},z:3},
              {name:'距前高回撤（右軸）',type:'line',yAxisIndex:1,data:c.drawdown,showSymbol:false,lineStyle:{width:1.5,color:cssVar('--down')},itemStyle:{color:cssVar('--down')},
               areaStyle:{color:'rgba(23,164,75,.18)'}}]});
  }};
}

/* ---------- 分頁：美股連動 ---------- */
function rUS(d){
  var rows=d.rows||[];
  if(!d.available) return {html:empty(d.reason,usInput())+(rows.length?usTable(d,rows):''),after:function(){bindUS();}};
  if(!st.usPick||!rows.some(function(r){return r.ticker===st.usPick&&r.available;})) st.usPick=d.best;
  var h=banner(d.headline,'區間 '+esc(d.from)+' ～ '+esc(d.to)+' · 美股收盤在台股收盤之後，所以美股當天的漲跌對應台股「下一個交易日」','pw-us');
  h+='<div class="pw-box"><div class="pw-scroll">'+usTable(d,rows)+'</div>'+usInput()+'</div>';
  h+='<div class="pw-box"><h4 id="pw-us-title"></h4><div class="pw-chart tall" id="pw-c1"></div></div>';
  h+='<p class="pw-note">隔日相關：美股收盤漲跌與台股下一交易日漲跌的相關係數（台股休市跨好幾天時，美股漲跌連乘）。同日相關：同一個日曆日。β：美股漲 1%，台股隔日平均漲幾 %。同向率：兩邊同漲或同跌的比例。相關係數 0.1 以下幾乎無關、0.3 以下弱、0.5 以上強。</p>';
  return {html:h,after:function(){ bindUS(); drawScatter(d); }};
}
function usInput(){
  return '<div class="pw-inline">加入其他美股代號：<input id="pw-us-extra" maxlength="60" placeholder="例：AVGO,MU" value="'+esc(st.us)+'">'+
    '<button type="button" class="btn" id="pw-us-apply">套用</button><span>隔日相關＝美股收盤漲跌 vs 台股下一交易日漲跌；點列可切換下方散佈圖。最多再加 4 檔。</span></div>';
}
function usTable(d,rows){
  var head='<tr><th>美股</th><th>隔日相關</th><th>同日相關</th><th>β（隔日）</th><th>同向率</th><th>美股大漲 ≥2% 隔日</th><th>美股大跌 ≤−2% 隔日</th><th>最新美股</th><th>樣本</th></tr>';
  var body=rows.map(function(r){
    if(!r.available) return '<tr><td>'+esc(r.name)+'<small>'+esc(r.ticker)+'</small></td><td colspan="8" class="flat">'+esc(r.reason||'無資料')+'</td></tr>';
    var u=r.up2, w=r.down2;
    return '<tr data-pw-us="'+esc(r.ticker)+'"'+(r.ticker===st.usPick?' class="pw-pick"':'')+'><td>'+esc(r.name)+'<small>'+esc(r.ticker)+'</small></td>'+
      '<td><b>'+nf(r.corr_next)+'</b> '+esc(r.strength)+'</td><td>'+nf(r.corr_same)+'</td><td>'+nf(r.beta)+'</td><td>'+(ok(r.same_dir)?nf(r.same_dir,0)+'%':'—')+'</td>'+
      '<td>'+(u.n?'<span class="'+cls(u.avg)+'">'+sg(u.avg)+'%</span> 漲機率 '+nf(u.prob,0)+'%<small>（'+u.n+'次）</small>':'—')+'</td>'+
      '<td>'+(w.n?'<span class="'+cls(w.avg)+'">'+sg(w.avg)+'%</span> 跌機率 '+nf(w.prob,0)+'%<small>（'+w.n+'次）</small>':'—')+'</td>'+
      '<td>'+(r.latest?'<span class="'+cls(r.latest.ret)+'">'+sg(r.latest.ret)+'%</span><small>'+md(r.latest.date)+'</small>':'—')+'</td><td>'+r.n+'</td></tr>';
  }).join('');
  return '<table class="pw-table"><thead>'+head+'</thead><tbody>'+body+'</tbody></table>';
}
function bindUS(){
  var b=$('pw-us-apply'); if(!b) return;
  var go=function(){ st.us=$('pw-us-extra').value.trim().toUpperCase(); remember(); load(false); };
  b.addEventListener('click',go);
  $('pw-us-extra').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); go(); } });
  document.querySelectorAll('[data-pw-us]').forEach(function(tr){
    tr.addEventListener('click',function(){ st.usPick=tr.dataset.pwUs;
      document.querySelectorAll('[data-pw-us]').forEach(function(x){x.classList.toggle('pw-pick',x===tr);});
      drawScatter(st.cache[key()]); });
  });
}
function drawScatter(d){
  if(!d||!d.rows) return;
  var r=d.rows.filter(function(x){return x.ticker===st.usPick&&x.available;})[0]; if(!r) return;
  $('pw-us-title').textContent=r.name+' 漲跌 → '+(d.name||d.code)+' 隔日漲跌（β '+nf(r.beta)+'）';
  var old=st.charts.filter(function(c){ return c.getDom()===$('pw-c1'); })[0];
  if(old){ old.dispose(); st.charts.splice(st.charts.indexOf(old),1); }
  var pts=r.scatter||[], k=scale(), ax=axisBase();
  var xs=pts.map(function(p){return Math.abs(p[0]);}), lim=Math.max.apply(null,xs.concat([2]));
  lim=Math.ceil(lim*10)/10;
  var a=(r.alpha||0)*100, b=r.beta||0;
  var last=pts[pts.length-1];
  makeChart('pw-c1',{animation:false,grid:{left:54,right:24,top:18,bottom:44},
    tooltip:Object.assign(tip(),{trigger:'item',formatter:function(p){ var x=p.data; if(!x||x.length<3) return ''; return esc(x[2])+'<br>'+esc(r.ticker)+' 前一晚 '+sg(x[0])+'%<br>'+esc(d.code)+' 當天 '+sg(x[1])+'%'; }}),
    xAxis:Object.assign({type:'value',min:-lim,max:lim,name:r.name+' 當日漲跌 →',nameLocation:'middle',nameGap:26,nameTextStyle:{color:cssVar('--muted'),fontSize:11*k}},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}}),
    yAxis:Object.assign({type:'value',scale:true},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}}),
    series:[{type:'scatter',symbolSize:6,data:pts.slice(0,-1),itemStyle:{color:function(p){return p.data[1]>=0?cssVar('--up'):cssVar('--down');},opacity:.75}},
            {type:'scatter',symbolSize:13,data:last?[last]:[],itemStyle:{color:GOLD},z:5},
            {type:'line',data:[[-lim,a-b*lim],[lim,a+b*lim]],showSymbol:false,lineStyle:{type:'dashed',color:GOLD,width:1.5},silent:true,tooltip:{show:false}}]});
}

/* ---------- 分頁：分價量 ---------- */
function rVP(d){
  var w=d.windows[st.vp]||d.windows['120']||d.windows[Object.keys(d.windows)[0]];
  if(!d.windows[st.vp]) st.vp=Object.keys(d.windows).filter(function(k){return d.windows[k]===w;})[0];
  var seg='<span class="pw-seg">'+Object.keys(d.windows).map(function(k){ return '<button type="button" data-pw-vp="'+k+'" aria-pressed="'+(k===st.vp)+'">近 '+k+' 日</button>'; }).join('')+'</span>';
  var where={above:'價值區上方',below:'價值區下方',inside:'價值區內'}[w.where];
  var h=banner(d.headline,'區間 '+esc(w.from)+' ～ '+esc(w.to)+'（'+w.days+' 個交易日）· 每根 K 棒的成交量平均分攤到當天最高到最低之間','volume-profile');
  h+='<div class="pw-cards">'+
    card('最大量價位 POC',nf(w.poc),'區間內成交量最多的價位','gold')+
    card('價值區（'+nf(w.value_pct,0)+'% 成交量）',nf(w.val)+' ～ '+nf(w.vah),'下緣 VAL 支撐、上緣 VAH 壓力','blue')+
    card('收盤位置',nf(d.close),where+' · '+esc(d.date),w.where==='above'?'up':w.where==='below'?'down':'')+
    card('上方最近大量區',w.resist?nf(w.resist.lo)+' ～ '+nf(w.resist.hi):'—',w.resist?'占 '+nf(w.resist.pct,1)+'% · 可能的壓力':'上方沒有大量區')+
    card('下方最近大量區',w.support?nf(w.support.lo)+' ～ '+nf(w.support.hi):'—',w.support?'占 '+nf(w.support.pct,1)+'% · 可能的支撐':'下方沒有大量區')+'</div>';
  h+='<div class="pw-box"><h4 style="display:flex;align-items:center;gap:10px">分價量（紅＝收紅 K 的量、綠＝收黑 K 的量，單位：張）'+seg+'</h4><div class="pw-chart tall" id="pw-c1"></div></div>';
  h+='<p class="pw-note">分價量把一段期間的成交量依價位加總：量越多的價位，代表越多人在那附近買賣（成本區）。股價在大量區上方時，大量區常成為支撐；在下方時常成為壓力。</p>';
  return {html:h,after:function(){
    document.querySelectorAll('[data-pw-vp]').forEach(function(b){ b.addEventListener('click',function(){ st.vp=b.dataset.pwVp; remember(); render(st.cache[key()]); }); });
    var L=w.levels, k=scale(), ax=axisBase(), up=cssVar('--up'), dn=cssVar('--down');
    var mark=function(v,name,color){ return {yAxis:v,name:name,lineStyle:{color:color,type:'dashed',width:1.4},label:{formatter:name+' '+nf(v),color:color,fontSize:11*k,position:'insideEndTop'}}; };
    /* 每個價位一條橫條：先畫收紅量，再接著畫收黑量（自訂系列，價位軸是連續的數值軸） */
    var bar=function(color){ return function(p,api){
      var a=api.coord([api.value(3),api.value(2)]), b=api.coord([api.value(0),api.value(1)]);
      return {type:'rect',shape:{x:a[0],y:a[1]+1,width:Math.max(0,b[0]-a[0]),height:Math.max(1,b[1]-a[1]-2)},style:{fill:color,opacity:.85}};
    }; };
    var fmtTip=function(p){ var x=L[p.dataIndex]; return nf(x.lo)+' ～ '+nf(x.hi)+'<br>收紅 '+nf(x.up,0)+' 張 · 收黑 '+nf(x.down,0)+' 張<br>占 '+nf(x.pct)+'%'; };
    makeChart('pw-c1',{animation:false,grid:{left:64,right:24,top:12,bottom:40},legend:legend(),tooltip:Object.assign(tip(),{trigger:'item',formatter:fmtTip}),
      xAxis:Object.assign({type:'value',min:0},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:function(v){return lots(v);}}}),
      yAxis:Object.assign({type:'value',min:L[0].lo,max:L[L.length-1].hi},ax,{splitLine:{show:false}}),
      series:[{name:'收紅 K 量',type:'custom',renderItem:bar(up),itemStyle:{color:up},encode:{x:[0,3],y:[1,2]},
                data:L.map(function(x){return [x.up,x.lo,x.hi,0];}),
                markLine:{symbol:'none',silent:true,data:[mark(w.poc,'POC',GOLD),mark(w.vah,'VAH',BLUE),mark(w.val,'VAL',BLUE),mark(d.close,'收盤','#ffffff')]}},
              {name:'收黑 K 量',type:'custom',renderItem:bar(dn),itemStyle:{color:dn},encode:{x:[0,3],y:[1,2]},
                data:L.map(function(x){return [x.up+x.down,x.lo,x.hi,x.up];})}]});
  }};
}

/* ---------- 分頁：外資持股 ---------- */
function rForeign(d){
  var s=d.streak, stext=s>0?'連 '+s+' 日增加':s<0?'連 '+(-s)+' 日減少':'持平';
  var h=banner(d.headline,'','pw-foreign');
  h+='<div class="pw-cards">'+
    card('🌏 外資持股比率',unit(nf(d.ratio),'%'),esc(d.date)+' · '+stext,'blue')+
    card('5 日變化',unit(sg(d.ch5),'pt'),'',cls(d.ch5))+card('20 日變化',unit(sg(d.ch20),'pt'),'',cls(d.ch20))+
    card('60 日變化',unit(sg(d.ch60),'pt'),'',cls(d.ch60))+
    card('投資上限／剩餘空間',(ok(d.limit)?nf(d.limit,0)+'%':'—')+' ／ '+(ok(d.remain)?nf(d.remain)+'%':'—'),esc(d.room||''))+
    card('外資持有',unit(lots(d.shares),'張'),ok(d.issued)?'發行 '+lots(d.issued)+' 張':'')+'</div>';
  h+=chartBox('外資持股比率 vs 股價','pw-c1','tall');
  h+='<p class="pw-note">外資持股比率＝外資及陸資持有股數 ÷ 發行股數（證交所每日公布）。比率上升代表外資持續買進並持有；短線買賣超請看主畫面的三大法人。</p>';
  return {html:h,after:function(){ var c=d.chart; dualLine('pw-c1',c.date,[{name:'外資持股 %（左軸）',data:c.ratio,color:BLUE}],'收盤價（右軸）',c.close,'%'); }};
}

/* ---------- 分頁：借券／當沖 ---------- */
function rShort(d){
  var h='', s=d.sbl||{}, t=d.daytrade||{};
  h+=banner(d.headline,'','pw-sbl');
  if(s.available===false) h+=empty(s.reason);
  else{
    h+='<div class="pw-cards">'+
      card('🩳 借券賣出餘額',unit(nf(s.balance,0),'張'),esc(s.date),'purple')+
      card('5 日增減',unit(sg(s.ch5,0),'張'),'增加＝空方加碼',ok(s.ch5)?(s.ch5>0?'down':s.ch5<0?'up':''):'')+
      card('20 日增減',unit(sg(s.ch20,0),'張'),ok(s.pct20)?sg(s.pct20,1)+'%':'',ok(s.ch20)?(s.ch20>0?'down':s.ch20<0?'up':''):'')+
      card('回補天數',unit(nf(s.days_to_cover,1),'天'),'餘額 ÷ 20 日均量；越高代表空方壓力越大')+
      card('融券餘額',unit(nf(s.margin_short,0),'張'),'散戶放空')+'</div>';
    h+=chartBox('借券賣出餘額 vs 股價','pw-c1');
  }
  if(t.available===false) h+=empty(t.reason);
  else{
    h+='<div class="pw-cards">'+
      card('⚡ 當沖比率（最新）',unit(nf(t.latest,1),'%'),esc(t.date),ok(t.latest)&&t.latest>=40?'crit':'')+
      card('5 日平均',unit(nf(t.avg5,1),'%'),(t.hot?'🔥 ':'')+esc(t.flag),t.hot?'crit':'')+
      card('20 日平均',unit(nf(t.avg20,1),'%'),'')+'</div>';
    h+=chartBox('當沖比率（當沖成交量 ÷ 總成交量）','pw-c2','short');
  }
  h+='<p class="pw-note">借券賣出多半是法人或避險部位的放空，餘額會在還券或回補時減少；融券是信用交易的放空。當沖比率偏高代表短線資金進出頻繁，股價容易暴漲暴跌。</p>';
  return {html:h,after:function(){
    if(s.chart) dualLine('pw-c1',s.chart.date,[{name:'借券賣出餘額（左軸，張）',data:s.chart.balance,color:PURPLE}],'收盤價（右軸）',s.chart.close,'');
    if(t.chart){
      var k=scale(), ax=axisBase();
      makeChart('pw-c2',{animation:false,grid:{left:48,right:20,top:16,bottom:30},tooltip:Object.assign(tip(),{trigger:'axis',valueFormatter:function(v){return nf(v,1)+'%';}}),
        xAxis:Object.assign({type:'category',data:t.chart.date},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:md},splitLine:{show:false}}),
        yAxis:Object.assign({type:'value',max:function(v){return Math.max(50,Math.ceil(v.max/10)*10);}},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}}),
        series:[{type:'bar',data:t.chart.ratio.map(function(v){return {value:v,itemStyle:{color:v>=40?'#ff6b6b':v>=25?GOLD:BLUE}};}),
                 markLine:{symbol:'none',silent:true,data:[{yAxis:40,lineStyle:{color:'#ff6b6b',type:'dashed'},label:{formatter:'過熱 40%',color:'#ff6b6b',fontSize:11*k}}]}}]});
    }
  }};
}

/* ---------- 分頁：三率＋現金流 ---------- */
function rMargins(d){
  var pt=function(v){ return ok(v)?'<span class="'+cls(v)+'">'+sg(v,1)+'</span>':'—'; };
  var h=banner(d.headline,'','pw-margins');
  h+='<div class="pw-cards">'+
    card('毛利率',unit(nf(d.gm,1),'%'),esc(d.latest)+' · 季 '+pt(d.gm_qoq)+' · 年 '+pt(d.gm_yoy)+' pt','gold')+
    card('營益率',unit(nf(d.om,1),'%'),'季 '+pt(d.om_qoq)+' · 年 '+pt(d.om_yoy)+' pt','blue')+
    card('淨利率',unit(nf(d.nm,1),'%'),'季 '+pt(d.nm_qoq)+' · 年 '+pt(d.nm_yoy)+' pt','purple')+
    card('EPS（單季）',nf(d.eps),'近四季合計 '+nf(d.eps4))+
    card('現金流／淨利（近四季）',unit(nf(d.quality),'倍'),'營業現金流 '+money(d.cfo4)+' ／ 淨利 '+money(d.net4),ok(d.quality)?(d.quality>=1?'good':'warn'):'')+
    card('自由現金流（近四季）',money(d.fcf4),'營業現金流－資本支出',cls(d.fcf4))+'</div>';
  h+='<p class="pw-trend">'+esc(d.trend)+'</p>';
  h+='<div class="pw-2col">'+chartBox('三率走勢（%）','pw-c1')+chartBox('單季 營業現金流 vs 稅後淨利','pw-c2')+'</div>';
  h+='<p class="pw-note">現金流量表為年初累計數，已換算成單季；淨利為本期淨利（含非控制權益）。'+(d.no_revenue?'這檔沒有「營業收入」科目（多半是金融股），三率無法依一般公司的定義計算。':'金融股的三率定義不同，僅供參考。')+'</p>';
  return {html:h,after:function(){
    var c=d.chart, k=scale(), ax=axisBase();
    makeChart('pw-c1',{animation:false,grid:{left:46,right:16,top:16,bottom:46},legend:legend(),tooltip:Object.assign(tip(),{trigger:'axis',valueFormatter:function(v){return nf(v,1)+'%';}}),
      xAxis:Object.assign({type:'category',data:c.q},ax,{splitLine:{show:false}}),yAxis:Object.assign({type:'value',scale:true},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}}),
      series:[['毛利率',c.gm,GOLD],['營益率',c.om,BLUE],['淨利率',c.nm,PURPLE]].map(function(x){ return {name:x[0],type:'line',data:x[1],connectNulls:true,symbolSize:6,lineStyle:{width:2,color:x[2]},itemStyle:{color:x[2]}}; })});
    makeChart('pw-c2',{animation:false,grid:{left:62,right:16,top:16,bottom:46},legend:legend(),tooltip:Object.assign(tip(),{trigger:'axis',valueFormatter:function(v){return money(v);}}),
      xAxis:Object.assign({type:'category',data:c.q},ax,{splitLine:{show:false}}),yAxis:Object.assign({type:'value'},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:function(v){return money(v);}}}),
      series:[{name:'營業現金流',type:'bar',data:c.cfo,itemStyle:{color:TEAL}},{name:'稅後淨利',type:'bar',data:c.net,itemStyle:{color:PURPLE}}]});
  }};
}

/* ---------- 分頁：填息 ---------- */
function rDividend(d){
  var h=banner(d.headline,'','pw-fill');
  h+='<div class="pw-cards">'+
    card('除權息次數',unit(nf(d.count,0),'次'),esc(d.first)+' ～ '+esc(d.last))+
    card('當天填息',unit(nf(d.same_day,0),'%'),'n='+d.same_n)+
    card('20 日內填息',unit(nf(d.within20,0),'%'),'n='+d.n20)+
    card('60 日內填息',unit(nf(d.within60,0),'%'),esc(d.grade||'')+' · n='+d.n60,ok(d.within60)?(d.within60>=80?'good':d.within60>=60?'gold':'warn'):'')+
    card('平均／中位填息天數',nf(d.avg_days,0)+' ／ '+nf(d.median_days,0)+'<small>天</small>','已填息 '+d.filled+' 次')+
    card('平均現金殖利率',unit(nf(d.avg_yield),'%'),'以除息前一日收盤價計算')+'</div>';
  var rows=d.rows.map(function(r){
    var days=r.filled?'<span class="'+(r.days<=20?'pw-fast':r.days<=60?'pw-mid':'pw-slow')+'">'+r.days+' 天</span>':'<span class="down">—</span>';
    return '<tr><td>'+esc(r.date)+'</td><td>'+esc(r.kind)+'</td><td>'+nf(r.amount,2)+'</td><td>'+nf(r['yield'])+'%</td><td>'+nf(r.before)+'</td><td>'+days+'</td>'+
      '<td>'+(r.filled?'填息 '+esc(r.fill_date):'未填息（'+r.elapsed+' 天）')+'</td></tr>';
  }).join('');
  h+='<div class="pw-box"><h4>歷次除權息紀錄</h4><div class="pw-scroll"><table class="pw-table"><thead><tr><th>除權息日</th><th>類別</th><th>權息值（元）</th><th>殖利率</th><th>除權息前價</th><th>填息天數</th><th>狀態</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
    '<p class="pw-note">填息＝除權息後收盤價回到除權息前一日收盤價；天數以交易日計，0 天＝除權息當天填息。比例的分母只算觀察期已滿的次數，近期已填息也不提前納入。股價資料從 '+esc(d.price_from)+' 起。</p></div>';
  if((d.excluded||[]).length) h+='<p class="pw-warn">已排除：'+d.excluded.map(function(x){return esc(x.date)+'（'+esc(x.reason)+'）';}).join('、')+'</p>';
  return {html:h};
}

/* ---------- 分頁：季節性 ---------- */
function rSeason(d){
  var fmt=function(list){ return list.map(function(s){return s.month+'月';}).join('、')||'—'; };
  var fmtv=function(list){ return list.map(function(s){return sg(s.avg,1)+'%';}).join(' / '); };
  var h=banner(d.headline,'','pw-season');
  h+='<div class="pw-cards">'+
    card('🔥 歷史最強月份',fmt(d.strong),fmtv(d.strong),'up')+
    card('🧊 歷史最弱月份',fmt(d.weak),fmtv(d.weak),'down')+
    card('統計期間',esc(d.from)+' ～ '+esc(d.to),d.complete+' 個完整月份')+'</div>';
  h+=chartBox('各月份平均漲跌（柱）與勝率','pw-c1','','');
  var cell=function(m){
    if(!m) return '<td></td>';
    var v=m.ret, a=Math.min(1,Math.abs(v||0)/20), bg=v>0?'rgba(229,72,77,'+(0.15+a*0.6)+')':v<0?'rgba(23,164,75,'+(0.15+a*0.6)+')':'transparent';
    return '<td class="'+(m.partial?'pw-partial':'')+'" style="background:'+bg+'" title="'+(m.partial?esc(m.reason||'資料不完整，不列入統計'):'')+'">'+nf(v,1)+(m.partial?'*':'')+'</td>';
  };
  h+='<div class="pw-box"><h4>逐年逐月漲跌（%）</h4><div class="pw-scroll"><table class="pw-table pw-heat"><thead><tr><th>年</th>'+
    [1,2,3,4,5,6,7,8,9,10,11,12].map(function(m){return '<th>'+m+'月</th>';}).join('')+'</tr></thead><tbody>'+
    d.table.map(function(y){ return '<tr><td>'+y.year+'</td>'+y.months.map(cell).join('')+'</tr>'; }).join('')+'</tbody></table></div>'+
    '<p class="pw-note">月報酬以日報酬連乘，除權息日改用參考價（排除除息造成的下跌）。* 為尚未結束或資料不完整的月份，不列入統計；樣本少於 5 年時參考價值有限。</p></div>';
  return {html:h,after:function(){
    var M=d.months, k=scale(), ax=axisBase();
    makeChart('pw-c1',{animation:false,grid:{left:50,right:16,top:16,bottom:54},tooltip:Object.assign(tip(),{trigger:'axis',
        formatter:function(p){ var m=M[p[0].dataIndex]; return m.month+' 月<br>平均 '+sg(m.avg,1)+'%<br>勝率 '+nf(m.win,0)+'%（'+m.n+' 年）'; }}),
      xAxis:Object.assign({type:'category',data:M.map(function(m){return m.month+'月\n'+(ok(m.win)?nf(m.win,0)+'%':'—');})},ax,
        {axisLabel:{color:cssVar('--muted'),fontSize:11*k,lineHeight:18*k,rich:{}},splitLine:{show:false}}),
      yAxis:Object.assign({type:'value'},ax,{axisLabel:{color:cssVar('--muted'),fontSize:11*k,formatter:'{value}%'}}),
      series:[{type:'bar',barWidth:'62%',data:M.map(function(m){ return {value:m.avg,itemStyle:{color:(m.avg||0)>=0?'rgba(229,72,77,.78)':'rgba(23,164,75,.85)'}}; })}]});
  }};
}

var RENDER={holders:rHolders,risk:rRisk,us:rUS,vp:rVP,foreign:rForeign,short:rShort,margins:rMargins,dividend:rDividend,season:rSeason};

/* ---------- 讀取與畫面 ---------- */
function key(){ return st.code+'|'+st.tab+'|'+st.us+'|'+(($('a-fm')||{}).value||'')+'|'+!!(($('a-yahoo')||{}).checked)+'|'+settingsRevision; }
function fresh(k){ var m=cacheMeta[k]; return !!(st.cache[k]&&m&&m.day===taipeiDay()&&Date.now()-m.time>=0&&Date.now()-m.time<m.ttl); }
function invalidate(){ ++st.req; if(requestController) requestController.abort(); requestController=null; }

function drawTabs(){
  $('pw-tabs').innerHTML=TABS.map(function(t){
    var icon=t[0]==='us'?'<i class="pw-us">US</i>':'<i class="pw-ic" aria-hidden="true">'+t[1]+'</i>';
    return '<button type="button" role="tab" data-pw-tab="'+t[0]+'" aria-selected="'+(t[0]===st.tab)+'">'+icon+esc(t[2])+'</button>';
  }).join('');
}
function subtitle(d){
  $('pw-sub').textContent=(d&&d.name?d.name+'（'+d.code+'）':st.code?st.code:'')+
    '　・　大戶持股／風險指標／美股連動等九個面向，只用實際抓到的資料';
}
function render(d){
  dispose();
  if(!d){ return; }
  subtitle(d);
  var tab=d.part, out;
  try{
    out=d.available===false&&tab!=='us'&&tab!=='short'?{html:empty(d.reason)}:RENDER[tab](d);
  }catch(err){ out={html:empty('畫面產生時發生問題：'+err.message)}; }
  var warn=(d.warnings||[]).length?'<p class="pw-warn">⚠ '+d.warnings.map(esc).join('；')+'</p>':'';
  if((d.splits||[]).length) warn+='<p class="pw-note">已依來源參考價確認'+d.splits.map(function(x){
      return esc(x.date)+(x.ratio>1?' 分割／面額變更（參考價比約 1： '+nf(x.ratio,2)+'）':' 股票合併（參考價約 ×'+nf(1/x.ratio,2)+'）'); }).join('、')+
    '：之前的股價與成交量已換算成現在的單位，圖表與報酬不會出現假的斷崖；填息表的權息值與除權息前價仍是當時的原始數字。</p>';
  var foot='<p class="pw-foot">資料：'+esc(d.source)+' · 股價最新 '+esc(d.last_date)+' · 產生 '+esc(d.generated)+
    (d.demo?' · <b>示範資料（非真實行情）</b>':'')+' · 規則計算與歷史統計，不是投資建議</p>';
  $('pw-body').innerHTML=out.html+warn+foot;
  if(out.after){ try{ out.after(); }catch(err){ $('pw-body').insertAdjacentHTML('afterbegin','<p class="pw-warn">圖表無法顯示：'+esc(err.message)+'</p>'); } }
  $('pw-body').scrollTop=0;
}
function busy(on){ $('pw-bar').classList.toggle('on',!!on); $('pw-go').disabled=!!on; $('pw-refresh').disabled=!!on; }
function params(refresh){
  var p=new URLSearchParams({code:st.code,part:st.tab});
  if(refresh) p.set('refresh','1');
  if(st.tab==='us'&&st.us) p.set('us',st.us);
  var fm=$('a-fm'); if(fm&&fm.value.trim()) p.set('finmind',fm.value.trim());
  var yh=$('a-yahoo'); if(yh&&yh.checked) p.set('yahoo','1');
  return p;
}
async function load(refresh){
  invalidate();
  var id=st.req;
  busy(false);
  if(!st.code){ dispose(); $('pw-body').innerHTML=empty('請在右上角輸入股票代號，按「分析」。'); return; }
  var k=key();
  if(!refresh&&fresh(k)) return render(st.cache[k]);
  var name=TABS.filter(function(t){return t[0]===st.tab;})[0][2];
  var controller=new AbortController(); requestController=controller;
  dispose(); busy(true);
  $('pw-body').innerHTML='<div class="pw-loading"><span class="sp"></span>正在讀取 '+esc(st.code)+' 的「'+esc(name)+'」資料…第一次開啟需要下載，約需幾秒到十幾秒；之後會沿用本機快取。</div>';
  try{
    var r=await fetch('/api/power?'+params(refresh),{signal:controller.signal}); var j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||'讀取失敗');
    if(id!==st.req||controller.signal.aborted||!dlg.open||k!==key()) return;
    st.cache[k]=j.data;
    cacheMeta[k]={time:Date.now(),day:taipeiDay(),ttl:Math.min(CACHE_MS,(j.data.cache_ttl_seconds||120)*1000)};
    var keys=Object.keys(st.cache);
    while(keys.length>96){var oldest=keys.shift();delete st.cache[oldest];delete cacheMeta[oldest];}
    render(j.data);
  }catch(err){
    if(err.name!=='AbortError'&&id===st.req&&dlg.open){ dispose(); $('pw-body').innerHTML=empty(err.message,'<div style="margin-top:12px"><button type="button" class="btn" id="pw-retry">再試一次</button></div>');
      $('pw-retry').addEventListener('click',function(){ load(true); }); }
  }finally{ if(id===st.req){requestController=null;busy(false);} }
}
function currentCode(){
  try{ var P=window.TWBoard&&TWBoard.payload&&TWBoard.payload(); return P&&P.code?P.code:''; }catch(e){ return ''; }
}
function open(code){
  code=String(code||'').trim().toUpperCase();
  drawTabs();
  if(!dlg.open){ document.documentElement.classList.add('pw-lock'); if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open',''); }
  if(code&&code!==st.code){ st.code=code; st.usPick=null; }
  $('pw-code').value=st.code;
  subtitle(null);
  load(false);
  if(!st.code) $('pw-code').focus();
}
function close(){
  invalidate(); busy(false);
  dispose();
  if(dlg.open){ if(dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
  document.documentElement.classList.remove('pw-lock');
}
dlg.addEventListener('close',function(){ invalidate(); busy(false); dispose(); document.documentElement.classList.remove('pw-lock'); });
$('pw-tabs').addEventListener('click',function(e){
  var b=e.target.closest('[data-pw-tab]'); if(!b||b.dataset.pwTab===st.tab) return;
  st.tab=b.dataset.pwTab; remember(); drawTabs(); load(false);
});
$('pw-tabs').addEventListener('keydown',function(e){
  if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return;
  var i=TABS.map(function(t){return t[0];}).indexOf(st.tab)+(e.key==='ArrowRight'?1:-1);
  i=(i+TABS.length)%TABS.length; st.tab=TABS[i][0]; remember(); drawTabs(); load(false);
  var b=$('pw-tabs').querySelector('[data-pw-tab="'+st.tab+'"]'); if(b) b.focus();
});
$('pw-form').addEventListener('submit',function(e){
  e.preventDefault();
  var v=$('pw-code').value.trim().toUpperCase();
  if(!/^[0-9A-Z]{2,10}$/.test(v)){ $('pw-body').innerHTML=empty('股票代號格式不正確，請輸入像 2330、00403A 這樣的代號。'); return; }
  if(v!==st.code){ st.code=v; st.usPick=null; }
  load(false);
});
$('pw-refresh').addEventListener('click',function(){
  Object.keys(st.cache).forEach(function(k){ if(k.indexOf(st.code+'|')===0) {delete st.cache[k];delete cacheMeta[k];} });   // 其他分頁下次開啟也重新確認
  load(true);
});
$('pw-body').addEventListener('click',function(e){
  var g=e.target.closest('[data-glossary-open]');
  if(g&&window.TWGlossary){ e.preventDefault(); e.stopPropagation(); TWGlossary.open(g.dataset.glossaryOpen||''); }
});
$('pw-close').addEventListener('click',close);
$('pw-kline').addEventListener('click',function(){
  var code=st.code; close();
  if(!code) return;
  var chip=document.querySelector('#chips [data-code="'+code+'"]');
  if(currentCode()===code){ var s=$('stage'); if(s&&!s.hidden) s.scrollIntoView({behavior:'smooth',block:'start'}); }
  else if(chip) chip.click();
  else if($('f-code')&&$('form')){ $('f-code').value=code; $('form').requestSubmit(); }
});
document.addEventListener('click',function(e){
  var b=e.target.closest('#btn-power,[data-power-open]'); if(!b) return;
  e.preventDefault(); open(b.dataset.powerOpen||currentCode());
});

window.TWPower={open:open,close:close,state:function(){return st;}};

function refreshIfExpired(){ if(dlg.open&&!document.hidden&&!requestController&&st.code&&!fresh(key())) load(false); }
setInterval(refreshIfExpired,60000);
document.addEventListener('visibilitychange',refreshIfExpired);
window.addEventListener('focus',refreshIfExpired);
window.addEventListener('twboard-settings-changed',function(){settingsRevision++;st.cache={};cacheMeta={};invalidate();busy(false);if(dlg.open)load(false);});
['a-fm','a-yahoo'].forEach(function(id){var el=$(id);if(el)el.addEventListener('change',function(){window.dispatchEvent(new Event('twboard-settings-changed'));});});
})();
