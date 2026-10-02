/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
const assert=require('assert');const E=require('./strategy_engine.js');
function fixture(n=20){return {events_confirmed:true,events:[],bars:Array.from({length:n},(_,i)=>({date:'2026-01-'+String(i+1).padStart(2,'0'),open:100,close:100,vol:100,score:80,chip_complete:true,bb_break_up:false}))};}
const zero={fee:0,tax:0,slip:0,hold:5};
let data=fixture(12),r=E.simulate(data,zero);
assert.equal(r.trades.length,3);assert.deepStrictEqual(r.trades.map(t=>[t.entry,t.exit,t.status]),[['2026-01-02','2026-01-06','closed'],['2026-01-07','2026-01-11','closed'],['2026-01-12',null,'open']]);
assert.equal(r.metrics.net_return,0);assert.equal(r.metrics.open,1);assert.equal(r.metrics.closed,2);
// Entry uses tomorrow's open, not the signal-day close; end valuation never forces a fictional fill.
data=fixture(3);data.bars[1].open=110;data.bars[1].close=110;data.bars[2].close=121;
r=E.simulate(data,zero);assert(Math.abs(r.metrics.net_return-10)<1e-9);assert.equal(r.trades[0].status,'open');assert.equal(r.trades[0].exit,null);
// Costs multiply the actual entry/exit fills; daily unrealized drawdown is captured.
data=fixture(7);r=E.simulate(data,{fee:1,tax:2,slip:1,hold:5});
let expected=(100*.99*.97/(100*1.01*1.01)-1)*100;
assert(Math.abs(r.trades[0].net_return-expected)<1e-9);
data=fixture(6);data.bars[3].close=80;r=E.simulate(data,zero);assert.equal(r.metrics.net_return,0);assert.equal(r.metrics.max_drawdown,20);
// New strategy variants and missing institutional data do not silently pass.
data=fixture(8);data.bars[2].bb_break_up=true;data.bars[2].score=50;
r=E.simulate(data,Object.assign({},zero,{signal:'bb'}));assert.equal(r.trades[0].signal,'2026-01-03');
assert.equal(E.simulate(data,Object.assign({},zero,{signal:'both'})).trades.length,0);
data.bars.forEach(b=>b.chip_complete=false);assert.equal(E.simulate(data,zero).trades.length,0);
assert(E.simulate(data,Object.assign({},zero,{require_chip:false})).trades.length>0);
// Truncation cannot change past signals/fills or the prefix of the daily curve.
data=fixture(20);let full=E.simulate(data,zero),prefix=E.simulate(Object.assign({},data,{bars:data.bars.slice(0,8)}),zero);
assert.deepStrictEqual(prefix.curve,full.curve.slice(0,8));assert.deepStrictEqual(prefix.trades[0],full.trades[0]);
// A last-day-only signal cannot trade before the next session exists.
data=fixture(6);data.bars.forEach(b=>b.score=0);data.bars.at(-1).score=80;
r=E.simulate(data,zero);assert.equal(r.trades.length,0);assert.equal(r.unfilled_signals,1);
// Known held ex-date blocks capital metrics, without deleting losing/event trades retrospectively.
data=fixture(8);data.events=['2026-01-04'];r=E.simulate(data,zero);
assert.equal(r.metrics,null);assert.equal(r.curve.length,0);assert.equal(r.trades.length,2);assert.equal(r.trades[0].net_return,null);assert.equal(r.trades[1].net_return,0);
data.events=['2026-01-02'];assert(E.simulate(data,zero).metrics); // ex-date entry at open carries no prior entitlement
// Unknown event coverage never asserts a complete return series.
data=fixture();data.events_confirmed=false;r=E.simulate(data,zero);assert.equal(r.metrics,null);assert.equal(r.baseline,null);assert(r.trades.every(t=>t.net_return===null));
// No lookahead skip based on future sell volume: entry remains, aggregate is invalidated.
data=fixture(8);data.bars[5].vol=0;r=E.simulate(data,zero);assert.equal(r.trades[0].entry,'2026-01-02');assert.equal(r.metrics,null);
data=fixture(8);data.bars[1].vol=0;r=E.simulate(data,zero);assert.equal(r.skipped_entry,1);assert.equal(r.trades[0].entry,'2026-01-03');
// Later segment restarts flat; start/end filters and a short interval are deterministic.
data=fixture(20);r=E.simulate(data,Object.assign({},zero,{segment:'late'}));assert.equal(r.from,'2026-01-15');assert.equal(r.trades[0].entry,'2026-01-16');
r=E.simulate(data,Object.assign({},zero,{start:'2026-01-05',end:'2026-01-10'}));assert.equal(r.days,6);assert.equal(r.trades[0].entry,'2026-01-06');
assert.equal(E.simulate(data,{start:'2026-02-01'}).metrics,null);
for(const o of [{fee:NaN},{slip:Infinity},{hold:1.5},{hold:0},{tax:-1},{threshold:101},{signal:'x'},{segment:'x'},{require_chip:'false'},{start:'bad'},{start:'2026-02-01',end:'2026-01-01'},{fee:''}])assert.throws(()=>E.simulate(data,o));
console.log('PASS: next-open execution, no overlap/lookahead, open positions, fees/tax/slip, daily drawdown, score/BB strategies, missing data/events, interval split, strict options');
