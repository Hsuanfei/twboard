/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* Deterministic replay shared by browser, offline reports and Node regression tests. */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.TWStrategy=factory();
})(typeof window==='undefined'?globalThis:window,function(){
'use strict';
var defaults={signal:'score',threshold:72,hold:5,fee:0.1425,tax:0.3,slip:0.05,require_chip:true,segment:'all',start:'',end:''};
function settings(options){
  var o=Object.assign({},defaults,options||{});
  if(!['score','bb','both'].includes(o.signal)||!['all','early','late'].includes(o.segment)) throw Error('請選擇有效的回測規則與區間');
  [['threshold',0,100],['hold',1,60],['fee',0,5],['tax',0,5],['slip',0,5]].forEach(function(x){
    if(o[x[0]]===''||o[x[0]]===null) throw Error('回測數值不可留空');
    o[x[0]]=Number(o[x[0]]);
    if(!Number.isFinite(o[x[0]])||o[x[0]]<x[1]||o[x[0]]>x[2]) throw Error('回測數值超出允許範圍');
  });
  if(!Number.isInteger(o.hold)) throw Error('持有天數須為整數');
  if(typeof o.require_chip!=='boolean') throw Error('法人完整度設定無效');
  ['start','end'].forEach(function(k){if(typeof o[k]!=='string'||(o[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(o[k])))throw Error('日期格式不正確');});
  if(o.start&&o.end&&o.start>o.end)throw Error('起日不可晚於迄日');
  return o;
}
function drawdown(values){var peak=100,max=0;values.forEach(function(v){peak=Math.max(peak,v);max=Math.max(max,(peak-v)/peak*100);});return max;}
function simulate(input,options){
  var o=settings(options),all=(input&&input.bars)||[];
  var selected=all.filter(function(b){return (!o.start||b.date>=o.start)&&(!o.end||b.date<=o.end);});
  var cut=Math.floor(selected.length*.7);
  if(o.segment==='early')selected=selected.slice(0,cut);
  if(o.segment==='late')selected=selected.slice(cut);
  var result={settings:o,from:selected.length?selected[0].date:null,to:selected.length?selected.at(-1).date:null,
    days:selected.length,trades:[],curve:[],benchmark:[],metrics:null,baseline:null,issues:[],baseline_issues:[],skipped_entry:0,unfilled_signals:0};
  if(selected.length<2){result.issues.push('區間至少需要2個完成暖身的交易日');return result;}
  var events=new Set((input&&input.events)||[]),confirmed=!!(input&&input.events_confirmed);
  var fee=o.fee/100,tax=o.tax/100,slip=o.slip/100;
  function buy(price){return price*(1+slip)*(1+fee);}
  function sell(price){return price*(1-slip)*(1-fee-tax);}
  function positive(v){return typeof v==='number'&&Number.isFinite(v)&&v>0;}
  function signal(b){
    if(o.require_chip&&!b.chip_complete)return false;
    var score=typeof b.score==='number'&&Number.isFinite(b.score)&&b.score>=o.threshold;
    return o.signal==='score'?score:o.signal==='bb'?b.bb_break_up===true:score&&b.bb_break_up===true;
  }
  var cash=100,pos=null,trade=null,invalid=false;
  result.curve.push({date:selected[0].date,value:100});
  for(var i=1;i<selected.length;i++){
    var b=selected[i],prior=selected[i-1];
    if(!pos&&signal(prior)){
      if(!positive(b.open)||!positive(b.vol)){result.skipped_entry++;}
      else{
        pos={units:cash/buy(b.open),entry:i,exit:i+o.hold-1,capital:cash};
        trade={signal:prior.date,entry:b.date,exit:null,planned_hold:o.hold,held:0,entry_price:b.open,exit_price:null,
          score:prior.score,status:'open',net_return:null,price_return:null,events:[],quality:[]};
        result.trades.push(trade);
      }
    }
    if(pos){
      // Entitlement changes on the entry date precede this simulated opening purchase.
      if(i>pos.entry&&events.has(b.date))trade.events.push(b.date);
      trade.held=i-pos.entry+1;
      if(!positive(b.close)){invalid=true;trade.quality.push('收盤價缺漏');}
      var value=positive(b.close)?pos.units*sell(b.close):cash;
      if(i===pos.exit){
        if(!positive(b.vol)){invalid=true;trade.quality.push('出場日無成交量');}
        trade.exit=b.date;trade.exit_price=b.close;trade.status='closed';
        trade.net_return=(value/pos.capital-1)*100;trade.price_return=(b.close/trade.entry_price-1)*100;
        cash=value;pos=null;trade=null;
      }
      result.curve.push({date:b.date,value:value});
    }else result.curve.push({date:b.date,value:cash});
  }
  if(pos){
    trade.exit_price=selected.at(-1).close;trade.valuation_date=selected.at(-1).date;
    trade.net_return=(result.curve.at(-1).value/pos.capital-1)*100;
    trade.price_return=(trade.exit_price/trade.entry_price-1)*100;
  }else if(signal(selected.at(-1)))result.unfilled_signals=1;
  if(!confirmed)result.issues.push('除權息資料未完整取得，無法確認持倉報酬');
  if(result.trades.some(function(t){return t.events.length;}))result.issues.push('持倉跨除權息，缺少還原／股利資料，暫停資金績效');
  if(invalid)result.issues.push('持倉資料或出場成交量不足，無法計算完整績效');
  var closed=result.trades.filter(function(t){return t.status==='closed';});
  if(!result.issues.length&&result.trades.length){
    result.metrics={net_return:result.curve.at(-1).value-100,max_drawdown:drawdown(result.curve.map(function(p){return p.value;})),
      closed:closed.length,open:pos?1:0,win:closed.length?closed.filter(function(t){return t.net_return>0;}).length/closed.length*100:null,
      mean:closed.length?closed.reduce(function(a,t){return a+t.net_return;},0)/closed.length:null};
  }
  result.trades.forEach(function(t){
    if(!confirmed||t.events.length||t.quality.length){t.net_return=null;t.price_return=null;}
  });
  if(result.issues.length)result.curve=[];
  var first=selected[1];
  if(!confirmed)result.baseline_issues.push('除權息資料不足');
  if(!positive(first.open)||!positive(first.vol)||!positive(selected.at(-1).vol))result.baseline_issues.push('基準進出場資料不足');
  if(selected.slice(1).some(function(b){return !positive(b.close);}))result.baseline_issues.push('基準收盤資料不足');
  if(selected.slice(2).some(function(b){return events.has(b.date);}))result.baseline_issues.push('買入持有期間跨除權息');
  if(!result.baseline_issues.length){
    var units=100/buy(first.open);
    result.benchmark=[{date:selected[0].date,value:100}].concat(selected.slice(1).map(function(b){return {date:b.date,value:units*sell(b.close)};}));
    result.baseline={net_return:result.benchmark.at(-1).value-100,max_drawdown:drawdown(result.benchmark.map(function(p){return p.value;}))};
  }
  return result;
}
return {defaults:defaults,settings:settings,simulate:simulate};
});
