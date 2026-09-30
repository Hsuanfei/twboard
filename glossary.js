/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 黃炫斐 (Mick Huang)
 * 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
 * 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。 */
/* ========================================================================
   指標名詞解釋（20260924a；0928a 加上 K 線型態、籌碼成本分佈與族群輪動圖表）
   畫面右上角的 ⓘ 按鈕打開。互動版與離線匯出的報告共用這一份。
   想修改說明文字，只要改下面 ENTRIES 裡的字串；公式要和 twboard.py／board.js 的實作一致。
   ======================================================================== */
(function(){
'use strict';

/* 每一格的名稱（「出現在」與速查表共用） */
var CARDS = {
  1:'01 主K線圖', 2:'02 決策核心', 3:'03 多維度判讀', 4:'04 收盤價分桶熱區', 5:'05 技術風險雷達',
  6:'06 KD 指標', 7:'07 MACD 動能', 8:'08 三大法人買賣超', 9:'09 風險監測', 10:'10 多空能量',
  11:'11 技術狀態綜合儀表', 12:'12 動能燈號', 13:'13 收盤價分桶量分布', 14:'14 資料可用度',
  15:'15 籌碼異動摘要', 16:'16 融資融券', 17:'17 評分總覽', 18:'18 戰略綜合研判'
};
/* 0930b 強力分析的名詞放在「強力分析」一類；where 用 'power'（見 PLACES） */
var PLACES = {
  head:'頁首行情列', dmi:'ADX／DMI 趨勢強度圖', cmp:'自選股比較表', filter:'比較表篩選',
  bt:'規則分回測', sim:'交易模擬', macro:'全球市場與匯率', raw:'原始資料表',
  scan:'市場掃描・選股清單', rank:'市場掃描・漲幅排行', etf:'市場掃描・熱門 ETF', sector:'市場掃描・族群輪動',
  alert:'市場掃描・到價警示', paper:'市場掃描・模擬持倉', toolbar:'分析工作台工具列', power:'強力分析'
};
/* 速查表：每一格對到最主要的一個名詞 */
/* 速查表：[圖卡, 主要名詞, 小字要列出的名詞（省略時只列主要名詞）] */
var INDEX = [
  [1,'candle-pattern',['kline-range','candle-pattern','pattern-winrate','volume-profile','value-area','ma','boll','fib','sr']],[2,'verdict',['verdict','ma-align','rs','bias','atr','plan']],
  [3,'radar3',['radar3','overall','trend-score','mom-score']],[4,'heat'],[5,'radar5',['radar5','rsi','atr','bias']],
  [6,'kd'],[7,'macd'],[8,'inst',['inst','inst-sum']],[9,'risk9',['risk9','rsi','kd','pos']],
  [10,'updown'],[11,'gauge11',['gauge11','rsi','kd','tech-score']],[12,'lamp12',['lamp12','ma-align','macd','bias','vol-dir']],
  [13,'vp'],[14,'data-avail'],[15,'inst-cum',['inst-cum','inst']],[16,'margin',['margin','vratio']],
  [17,'score17',['score17','tech-score','chip-score','overall']],[18,'plan',['plan','verdict','vwap']],
  ['dmi','dmi',['dmi','vol-dir','activity']],['cmp','cmp-cols',['cmp-cols','cmp-status','cmp-filter']],
  ['bt','bt-table'],['sim','bt-sim',['bt-sim','bt-metrics']],['macro','idx',['idx','fx','idx100','macro-chg']],
  ['scan','screen-rules',['screen-rules','scan-score','mk-tags','inst-streak']],['rank','rank-list',['rank-list','liquidity']],
  ['etf','etf-rank'],['sector','sector-rotation',['sector-rotation','quadrant-change','sector-heat','sector-rank','sector-timeline','sector-accel','themes']],
  ['alert','price-alert'],['paper','paper-trade'],
  ['power','pw-risk',['pw-holders','pw-risk','pw-sharpe','pw-downside','pw-us','pw-foreign','pw-sbl','pw-daytrade','pw-margins','pw-cash','pw-fill','pw-season']]
];
var CATS = [
  ['start','先讀這裡'], ['quote','行情與頁首'], ['trend','均線與趨勢'], ['momentum','動能指標'],
  ['vol','波動、通道與價位'], ['volume','量能與價量分布'], ['pattern','K 線型態與籌碼分佈'], ['chip','法人與信用交易'],
  ['score','評分與研判'], ['compare','比較表與篩選'], ['bt','回測與交易模擬'],
  ['macro','全球市場與匯率'], ['market','市場掃描與族群'], ['power','強力分析'], ['data','資料狀態']
];

/* ---------- 數字格式 ---------- */
function ok(v){ return typeof v==='number' && isFinite(v); }
function f(v,d){ if(!ok(v)) return '—'; d=d===undefined?2:d;
  return Number(v).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d}); }
function sg(v,d){ return ok(v) ? (v>0?'+':'')+f(v,d) : '—'; }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }
function macroSeries(M,id){ return M && M.series ? M.series.filter(function(s){return s.id===id;})[0] : null; }

/* ---------- 名詞 ----------
   what 是什麼 / calc 怎麼算 / read 怎麼看 / note 要注意；陣列會排成條列。
   where：數字＝第幾格，字串＝PLACES 的鍵。now(P, M)：目前這一檔的數值（沒有就回傳 null）。 */
var ENTRIES = [
/* ===== 先讀這裡 ===== */
{id:'rule-score', cat:'start', term:'規則分（0–100 分）', en:'rule-based score',
 where:[3,11,17,'cmp'],
 what:'畫面上所有「分」（趨勢、動能、籌碼、量價、技術、綜合）都是把公開資料套進一組固定規則，換算出來的 0–100 相對刻度。',
 read:'分數高代表「同時偏多的條件比較多」，適合用來快速比較不同股票或同一檔股票不同時間的狀態。',
 note:['不是勝率、不是上漲機率，也不是目標價。','計分口徑會隨版本調整（目前是 0922b-directional-volume），不同版本的分數不宜直接比較。','想知道高分之後實際漲跌如何，請看「規則分回測」。']},
{id:'no-data', cat:'start', term:'無資料 ／ —', en:'missing value',
 where:[14,'cmp'],
 what:'資料來源沒有提供，或歷史筆數不足以計算時，一律顯示「無資料」或「—」。',
 read:'評分項目缺資料時，這一項不計入，其他項目的權重等比例放大；比較表排序時缺值固定排在最後。',
 note:'本工具不用推估值或 0 去填補缺漏，所以「無資料」不等於「數值是 0」。'},
{id:'unadjusted', cat:'start', term:'價格未還原與除權息標記', en:'unadjusted price · ex-dividend',
 where:[1,'head','sim'],
 what:'所有價格都是當天實際成交價，沒有做除權息還原。除權息日在主K線圖上畫成黃色點狀直線，並標示權息金額。',
 read:'除權息當天股價會出現「假缺口」，均線、KD、布林通道、60 日支撐壓力和費波南希波段都會把這個缺口算進去；遇到標記時，指標的變化要打點折扣看。',
 note:['頁首「除權息確認」顯示是否已完整取得除權息資料。','交易模擬遇到持倉跨除權息時，會暫停顯示報酬，避免把配息當成下跌。'],
 now:function(P){ var d=P.dividends; if(!d) return null;
   if(!d.available) return '除權息資料'+(d.status==='partial'?'未完整更新':'未取得')+'，無法確認是否有事件';
   return d.recent.length ? '近 60 日有除權息：'+d.recent.map(function(e){return e.date+' '+e.kind+(ok(e.amount)?' '+f(e.amount,2):'');}).join('、') : '近 60 日沒有除權息事件'; }},
{id:'colors', cat:'start', term:'顏色與符號', en:'colors',
 where:[1,8,'head'],
 what:'依台股慣例「紅漲綠跌」，並用 ▲▼、正負號作為第二種辨識方式，不只靠顏色。',
 calc:['K 棒：收盤高於開盤畫空心的漲色框，收盤低於開盤畫實心的跌色（比的是當天開盤，不是昨收）。','頁首漲跌、比較表漲跌幅：比的是前一交易日收盤。','法人三色是身分色：藍＝外資、橘＝投信、青綠＝自營商，與漲跌無關。','分數環用單一藍色深淺，越亮分數越高，刻意不用紅綠。'],
 note:'紅綠色盲不易分辨紅綠，可按「色盲友善配色」把漲跌改成橘／藍。'},

/* ===== 行情與頁首 ===== */
{id:'close-chg', cat:'quote', term:'收盤價／漲跌／漲幅', en:'close · change',
 where:['head','cmp'],
 calc:['漲跌＝今日收盤 − 前一交易日收盤','漲幅＝漲跌 ÷ 前一交易日收盤 × 100%'],
 note:'交易所公告的漲跌是以「參考價」計算；除權息當天兩者可能不同，本工具用的是前一日收盤。',
 now:function(P){ var q=P.quote; return '收盤 '+f(q.close)+'，漲跌 '+sg(q.chg)+'（'+sg(q.chg_pct)+'%）'; }},
{id:'vol-trades', cat:'quote', term:'成交量（張）／成交筆數', en:'volume · trades',
 where:['head',1,'cmp'],
 what:'成交量是當天成交的股數換算成張（1 張＝1,000 股）；成交筆數是當天撮合成交的次數。',
 read:'主K線圖下方的柱狀圖是每日成交量，柱子顏色跟著當天 K 棒。',
 now:function(P){ var q=P.quote; return '成交量 '+f(q.vol,1)+' 張，成交筆數 '+(ok(q.trades)?Number(q.trades).toLocaleString('zh-TW'):'—')+'，20 日均量 '+f(q.vma20,1)+' 張'; }},
{id:'ohlc', cat:'quote', term:'開盤／最高／最低', en:'open · high · low',
 where:['head',1],
 what:'最新交易日的開盤價、盤中最高價與最低價。',
 read:'60 日支撐壓力、20／60 日位階、KD、ATR 都用盤中最高、最低價計算，不是只看收盤。',
 now:function(P){ var q=P.quote; return '開 '+f(q.open)+'、高 '+f(q.high)+'、低 '+f(q.low); }},
{id:'latest-date', cat:'quote', term:'最新交易日／資料筆數', en:'latest date',
 where:['head',14],
 what:'最新交易日是股價資料的最後一天；資料筆數是畫面上實際顯示的交易日數。',
 note:'法人與融資券常比股價晚公布，頁首會分別列出它們的最新日期；比股價舊時標「落後股價」。',
 now:function(P){ return '股價最新 '+P.last_date+'，顯示 '+P.bars_count+' 個交易日；法人最新 '+(P.avail.chip_latest||'無資料')+'，融資券最新 '+(P.avail.margin_latest||'無資料'); }},
{id:'analysis-days', cat:'quote', term:'分析天數與指標暖身', en:'window · warm-up',
 where:['head',1,4,10,13],
 what:'分析天數（10～500，預設 30）是畫面上「顯示」的交易日數。',
 calc:['指標一律先在完整取得的歷史上計算（另外往回多抓約 100 個交易日暖身），再切出最後 N 天顯示，所以只看 30 天時 MA60、MACD 也是正確值。','固定期間、不受分析天數影響：60 日支撐壓力、20／60 日位階、法人近 5／20 日、布林通道。','跟著分析天數改變：費波南希波段、04 熱區、13 分桶、10 多空能量、14 資料可用度。'],
 now:function(P){ return '分析天數 '+P.avail.need_days+'，實際顯示 '+P.bars_count+' 日，計算用 '+P.history_count+' 日歷史'; }},

/* ===== 均線與趨勢 ===== */
{id:'ma', cat:'trend', term:'移動平均線 MA5／MA10／MA20／MA60', en:'simple moving average',
 where:[1,'raw'],
 what:'最近 N 個交易日收盤價的簡單平均。MA5 約一週、MA10 約兩週、MA20 約一個月（月線）、MA60 約一季（季線）。',
 calc:'MA<sub>N</sub>＝最近 N 日收盤價加總 ÷ N',
 read:['收盤在均線之上：今天的價格高於近 N 日平均。','短均線在長均線之上：近期漲得比較多。','主K線圖上的線色：MA5 橘黃、MA10 淺綠（預設隱藏，點圖例可開啟）、MA20 紫、MA60 天藍；色盲友善配色時改用黃、青、紫、灰，避開漲跌色。'],
 note:'均線是過去價格的平均，一定落後於價格；盤整時容易頻繁交叉。',
 now:function(P){ var t=P.tech; return 'MA5 '+f(t.ma5)+'、MA10 '+f(t.ma10)+'、MA20 '+f(t.ma20)+'、MA60 '+f(t.ma60)+'；收盤 '+f(P.quote.close); }},
{id:'ma-align', cat:'trend', term:'均線排列（多頭／空頭／糾結）', en:'MA alignment',
 where:[2,12,18],
 calc:['MA5 > MA10 > MA20 → 多頭排列','MA5 < MA10 < MA20 → 空頭排列','其他情況 → 糾結'],
 read:'多頭排列表示短、中期均價依序墊高，是趨勢分最主要的加分來源。',
 note:'只看三條均線的相對位置，不看斜率，也不含 MA60。',
 now:function(P){ return '目前：'+P.tech.trend_txt; }},
{id:'bias', cat:'trend', term:'MA20 乖離', en:'bias ratio',
 where:[2,5,12],
 calc:'乖離＝(收盤 − MA20) ÷ MA20 × 100%',
 read:['正值＝價格在月線之上；數字越大離月線越遠。','12 動能燈號：|乖離| ≤ 5% 綠燈、5～10% 黃燈、> 10% 紅燈。','05 雷達把它換成 50 ＋ 乖離 × 3（限制在 0～100），約 ±16.7% 會到頂或到底。'],
 note:'乖離大常被說成「漲多會拉回」，但強勢股可以長時間維持高乖離，它描述的是距離，不是方向。',
 now:function(P){ var b=P.tech.bias20; return ok(b)?'MA20 乖離 '+sg(b)+'%（'+(Math.abs(b)>10?'紅燈':Math.abs(b)>5?'黃燈':'綠燈')+'）':null; }},
{id:'sr', cat:'trend', term:'60 日支撐／壓力', en:'60-day support · resistance',
 where:[1,2,18],
 calc:['60 日支撐＝近 60 個交易日（含今天）盤中最低價','60 日壓力＝近 60 個交易日盤中最高價'],
 read:['主K線圖畫成水平虛線（可用「支撐壓力」開關）；區間較短時，線可能超出畫面，改在圖下方文字寫出價位（避免把 K 棒壓扁）。','60 日壓力同時是「首目標」。'],
 note:'這只是近一季的區間邊界，不是用演算法找出來的支撐區，也不保證價格會在這裡止跌或受壓。',
 now:function(P){ var t=P.tech; return '支撐 '+f(t.support)+'、壓力 '+f(t.resistance)+'；收盤 '+f(P.quote.close); }},
{id:'pos', cat:'trend', term:'20 日／60 日位階', en:'range position',
 where:[2,3,5,9],
 calc:'位階＝(收盤 − N 日盤中最低) ÷ (N 日盤中最高 − N 日盤中最低) × 100',
 read:['0＝收在區間最低點，100＝收在區間最高點。','09 風險監測：≤ 25 藍（低檔區）、25～75 黃、≥ 75 紅（高檔區）。','03 雷達的「位階」軸用的是 60 日位階；60 日位階 ≥ 92 會觸發「已近壓力」的研判。'],
 now:function(P){ return '20 日位階 '+f(P.tech.pos20,0)+'%、60 日位階 '+f(P.tech.pos60,0)+'%'; }},
{id:'rs', cat:'trend', term:'相對大盤 20 日', en:'relative strength',
 where:[2,'cmp','filter'],
 calc:'相對大盤＝個股近 20 個交易日漲跌幅 − 同期大盤漲跌幅（單位：百分點）',
 read:['上市股比「加權價格指數」、上櫃股比「櫃買價格指數」，兩邊都是不含息的價格報酬。','＋3 點＝近 20 日比大盤多漲 3 個百分點；負值代表落後大盤。'],
 note:'只有 FinMind 來源提供大盤基準；證交所來源或市場別無法確認時顯示「無資料」。',
 now:function(P){ var b=P.bench;
   if(!b) return '無資料（未取得大盤基準）';
   if(!b.d20) return '無資料（'+b.name+'資料不足）';
   return '個股 '+sg(b.d20.stock)+'%、'+b.name+' '+sg(b.d20.index)+'%，相對大盤 '+sg(b.d20.rs)+' 點'; }},
{id:'dmi', cat:'trend', term:'ADX／DMI（＋DI、−DI）', en:'Average Directional Index',
 where:['dmi','cmp','filter','raw'],
 what:'Wilder 的方向指標（14 日）。＋DI、−DI 看漲跌哪一方力量大，ADX 看趨勢「強不強」。',
 calc:['＋DM＝今日最高 − 昨日最高；−DM＝昨日最低 − 今日最低（只取較大的一方且需大於 0，另一方記 0）','＋DI＝平滑後 ＋DM ÷ 平滑後真實區間 × 100；−DI 同理（Wilder 14 日平滑）','DX＝|＋DI − −DI| ÷ (＋DI ＋ −DI) × 100；ADX＝DX 的 14 日 Wilder 平滑','第一個 DI 需要 15 根 K 棒，第一個 ADX 需要 28 根；資料異常時重新暖身，缺值不補 0'],
 read:['＋DI 高於 −DI：上漲方向的力量較大。','ADX < 20 趨勢偏弱（接近盤整）、20～25 過渡區、≥ 25 趨勢較強。','ADX 只看強度不看方向，強勢下跌時 ADX 一樣會很高。'],
 note:'只作顯示與篩選，沒有加入綜合分。',
 now:function(P){ var d=P.dmi||{}; if(!ok(d.adx)) return 'ADX 資料不足（至少需 28 根 K 棒）';
   return 'ADX '+f(d.adx,1)+'（'+(d.adx<20?'趨勢偏弱':d.adx<25?'過渡區':'趨勢較強')+'）、＋DI '+f(d.plus_di,1)+'、−DI '+f(d.minus_di,1)+'（'+(d.plus_di>d.minus_di?'＋DI 較高':d.minus_di>d.plus_di?'−DI 較高':'方向持平')+'）'; }},

/* ===== 動能指標 ===== */
{id:'kd', cat:'momentum', term:'KD 指標（9,3,3）', en:'Stochastic Oscillator',
 where:[2,5,6,9,11,'raw'],
 calc:['RSV＝(今日收盤 − 近 9 日最低) ÷ (近 9 日最高 − 近 9 日最低) × 100（9 日內完全沒有波動時取 50）','K＝前一日 K × 2/3 ＋ 今日 RSV × 1/3','D＝前一日 D × 2/3 ＋ 今日 K × 1/3（K、D 起始值都是 50）'],
 read:['K、D 都在 0～100 之間；≥ 80 為超買區、≤ 20 為超賣區（06 圖上的兩條虛線）。','K 由下往上穿過 D 常被稱為「黃金交叉」，反之為「死亡交叉」；動能分裡 K > D 加分。','02「短線狀態」依 K 值顯示是否進入超買／超賣區。'],
 note:'強勢股可以長期停在 80 以上（高檔鈍化），「超買」不等於接下來會跌。',
 now:function(P){ var t=P.tech; return 'K '+f(t.k,1)+'、D '+f(t.d,1)+'：'+t.kd_txt; }},
{id:'macd', cat:'momentum', term:'MACD（12,26,9）：DIF／訊號線／OSC', en:'Moving Average Convergence Divergence',
 where:[7,12,'raw'],
 calc:['DIF＝收盤的 12 日 EMA − 26 日 EMA','訊號線＝DIF 的 9 日 EMA','OSC（柱狀體）＝DIF − 訊號線','EMA 以前 N 日的簡單平均起算'],
 read:['OSC > 0（漲色柱）＝DIF 在訊號線之上，動能偏多；柱子由長變短代表動能在減弱。','DIF 在 0 軸之上＝短期均價高於長期均價。','12 動能燈號只看 OSC 正負；動能分另外看 OSC 是擴大還是縮小。'],
 note:'MACD 由均線組成，反應一定比價格慢；盤整時容易正負來回翻轉。',
 now:function(P){ var t=P.tech; return 'DIF '+f(t.dif)+'、訊號線 '+f(t.sig)+'、OSC '+sg(t.osc); }},
{id:'rsi', cat:'momentum', term:'RSI14（相對強弱指標）', en:'Relative Strength Index',
 where:[5,9,11,'raw'],
 calc:['平均漲幅、平均跌幅都用 Wilder 14 日平滑','RS＝平均漲幅 ÷ 平均跌幅','RSI＝100 − 100 ÷ (1 ＋ RS)；全程只漲為 100，全程平盤為 50'],
 read:['> 70 常稱偏熱、< 30 常稱偏冷；09、11 以 30／70 分色。','動能分認為 50～70 最好（偏多但未過熱），70～80 次之。'],
 note:'強勢行情中 RSI 可以長期維持在 70 以上。',
 now:function(P){ var r=P.tech.rsi; return ok(r)?'RSI14 '+f(r,1)+'（'+(r>=70?'偏熱區':r<=30?'偏冷區':'中性區')+'）':null; }},

/* ===== 波動、通道與價位 ===== */
{id:'atr', cat:'vol', term:'ATR14 與 ATR%', en:'Average True Range',
 where:[2,5,18],
 calc:['真實區間 TR＝max(今日最高 − 今日最低, |今日最高 − 昨收|, |今日最低 − 昨收|)','ATR＝TR 的 14 日 Wilder 平滑','ATR%＝ATR ÷ 收盤 × 100%'],
 read:['代表這檔股票「平常一天」大約波動多少；ATR% 3% ≈ 平均每天約 3% 的振幅。','參考進場區與停損參考都用 ATR 換算。','05 雷達的「ATR 波動」＝ATR% × 10，ATR% 10% 以上即滿格。'],
 now:function(P){ var t=P.tech; return 'ATR '+f(t.atr)+' 元（'+f(t.atr_pct)+'%）'; }},
{id:'boll', cat:'vol', term:'布林通道（20 日、2σ）', en:'Bollinger Bands',
 where:[1,'raw'],
 calc:['中軌＝20 日收盤平均','上軌／下軌＝中軌 ± 2 × 20 日收盤的母體標準差'],
 read:['主K線圖上的藍色上下軌與淡色帶，黃色線是中軌；預設關閉，按「布林通道」開啟（比較表的布林欄位不受影響）。','通道變寬代表近期波動放大；價格沿著上軌走常見於強勢行情。'],
 note:'碰到上軌或下軌本身不是買賣訊號；布林通道沒有加入綜合分。',
 now:function(P){ var b=P.bollinger; return b&&ok(b.upper)?'上軌 '+f(b.upper)+'、中軌 '+f(b.mid)+'、下軌 '+f(b.lower):'布林資料不足'; }},
{id:'boll-pb', cat:'vol', term:'布林 %B', en:'%B',
 where:[1,'cmp','raw'],
 calc:'%B＝(收盤 − 下軌) ÷ (上軌 − 下軌)',
 read:'0＝在下軌、0.5＝在中軌、1＝在上軌；> 1 表示收在上軌外，< 0 表示收在下軌外。',
 note:'通道寬度為 0（20 日價格完全不動）時無法計算。',
 now:function(P){ var b=P.bollinger; return b&&ok(b.percent_b)?'%B '+f(b.percent_b,3):null; }},
{id:'boll-width', cat:'vol', term:'布林寬度%／寬度百分位／通道收斂', en:'bandwidth · squeeze',
 where:[1,'cmp','filter','raw'],
 calc:['寬度%＝(上軌 − 下軌) ÷ 中軌 × 100%','寬度百分位＝今天的寬度在「含今天的近 120 筆寬度」中排第幾（同值取中位名次），0～100','寬度百分位 ≤ 20 → 標示「通道收斂」'],
 read:'收斂表示波動降到近半年的低檔，常被視為可能變盤的前兆，但它不會告訴你往哪個方向。',
 note:'需要至少約 139 個交易日（20 日暖身＋120 筆）才判定收斂，不足時顯示「收斂歷史不足」。',
 now:function(P){ var b=P.bollinger; if(!b||!ok(b.width)) return null;
   return '寬度 '+f(b.width)+'%、寬度百分位 '+(ok(b.width_rank)?f(b.width_rank,1):'—（歷史不足）')+(b.squeeze===true?'：通道收斂':''); }},
{id:'boll-break', cat:'vol', term:'突破上軌／跌破下軌／軌外', en:'band break',
 where:[1,'cmp','filter','sim'],
 calc:['今日突破上軌＝今日收盤 > 今日上軌，且前一日收盤 ≤ 前一日上軌（第一次收到軌外）','今日跌破下軌＝今日收盤 < 今日下軌，且前一日收盤 ≥ 前一日下軌','上軌外／下軌外＝%B > 1／< 0，但不是今天才跨出去'],
 read:'比較表的「布林狀態」欄與篩選都用這些分類；交易模擬可以選「布林首次突破上軌」當進場條件。',
 now:function(P){ var b=P.bollinger; if(!b||!ok(b.upper)) return null;
   return b.break_up?'今日突破上軌':b.break_down?'今日跌破下軌':ok(b.percent_b)&&b.percent_b>1?'收在上軌外':ok(b.percent_b)&&b.percent_b<0?'收在下軌外':'收在通道內'; }},
{id:'fib', cat:'vol', term:'費波南希回撤', en:'Fibonacci Retracement',
 where:[1],
 what:'把主K線圖目前區間（近 60／120／250 日或分析天數）內的最高點與最低點當作一個波段，畫出幾條慣用的回撤比例線。預設關閉，按「費波南希」開啟。',
 calc:['低點在前、高點在後＝上升波段：0% 在高點、100% 在低點，各線＝高點 − 波段幅度 × 比率。','高點在前、低點在後＝下跌波段：0% 在低點、100% 在高點，各線＝低點 ＋ 波段幅度 × 比率。','比率：23.6%、38.2%、50%、61.8%、78.6%（50% 不是費波南希比率，是慣例一起畫的中點）；38.2%～61.8% 的淡色帶常被稱為「黃金回撤區」。','同價的高低點取最近一次；收盤離某條線小於波段幅度 0.2% 時視為「正好在線附近」。'],
 read:'圖下方讀數列會寫出波段起訖、目前已回撤（或反彈）幾 %、上下最近的兩條線與距離；今天仍在創波段新高／新低時標「尚未回撤」。',
 note:['沒有可靠的證據顯示價格會在這些比例轉折，請把它當成「大家可能在看的價位」。','切換主K線圖的區間，波段就會跟著變；今天的高低點明天可能被改寫。'],
 now:function(P){ var b=P.fibonacci; if(!b) return null; if(!b.available) return '無法計算：'+(b.reason||'資料不足');
   var up=b.direction==='up', a=up?b.low:b.high, z=up?b.high:b.low;
   return (up?'上升波段 ':'下跌波段 ')+a.date+' '+f(a.price)+' → '+z.date+' '+f(z.price)+'；'+
     (b.extending?'今天仍在創波段'+(up?'新高':'新低'):'已'+(up?'回撤 ':'反彈 ')+f(b.retraced_pct,1)+'%')+
     (b.at?'，正好在 '+b.at.label+' 附近':''); }},
{id:'vwap', cat:'vol', term:'20 日成交均價', en:'20-day VWAP',
 where:[1,2,18],
 calc:['典型價＝(最高 ＋ 最低 ＋ 收盤) ÷ 3','20 日成交均價＝近 20 日「典型價 × 成交量」加總 ÷ 近 20 日成交量加總'],
 read:'可以粗略看成近一個月成交的平均價位；收盤在它之上，表示近月買進的人平均而言帳面上是賺的（估計）。主K線圖上是紫色虛線。',
 note:'用日資料估算，不是逐筆成交的實際均價，也不是任何人的持股成本。',
 now:function(P){ var v=P.tech.vwap20; return ok(v)?'20 日成交均價 '+f(v)+'，收盤 '+f(P.quote.close)+(P.quote.close>=v?'（在其上）':'（在其下）'):null; }},

/* ===== 量能與價量分布 ===== */
{id:'vratio', cat:'volume', term:'量比', en:'volume ratio',
 where:[16,'cmp'],
 calc:'量比＝今日成交量 ÷ 含今日的 20 日平均成交量',
 read:'1 倍＝和平常差不多；≥ 1.3 倍視為放量、< 0.8 倍視為縮量。',
 now:function(P){ var q=P.quote; return ok(q.vratio)?'量比 '+f(q.vratio)+' 倍（今日 '+f(q.vol,1)+' 張 ÷ 20 日均量 '+f(q.vma20,1)+' 張）':null; }},
{id:'vol-dir', cat:'volume', term:'量價方向／量價分', en:'price-volume score',
 where:[12,'dmi','cmp'],
 calc:['量：放量（量比 ≥ 1.3）、平量（0.8～1.3）、縮量（< 0.8）','價：收盤比前一日上漲、下跌或平盤，合起來例如「放量上漲」','量價分＝50 ± 35 × min(量比 ÷ 2, 1)：上漲用加、下跌用減、平盤固定 50','量比 2 倍以上時，上漲為 85、下跌為 15；沒有成交量不計分'],
 read:'上漲又放量分數高、下跌又放量分數低；量價分佔綜合分的 15%。',
 now:function(P){ var v=P.volume_analysis||{}; return v.state?v.state+'，量價分 '+f(v.score,1):null; }},
{id:'activity', cat:'volume', term:'成交活躍度', en:'activity',
 where:['dmi'],
 calc:'只看量比、不分漲跌：≥ 2 倍 85、≥ 1.3 倍 72、≥ 0.8 倍 58、≥ 0.5 倍 42，以下 28。',
 note:'只顯示在 ADX／DMI 說明列，沒有加入任何評分。',
 now:function(P){ var v=P.volume_analysis||{}; return ok(v.activity)?'活躍度 '+f(v.activity,0):null; }},
{id:'heat', cat:'volume', term:'收盤價分桶熱區', en:'close-price heatmap',
 where:[4],
 calc:['把顯示期間的價格範圍切成最多 18 個價位桶（橫軸是時間，最多 14 段）。','每一天的「全日成交量」整筆歸入當天收盤價所在的價位桶，再依時段加總。'],
 read:'顏色越亮＝那個時段、那個價位累積的量越多，可以看出量在哪些價位、哪段時間比較集中。',
 note:'這是估計：不是各價位的實際成交量，也不是持股成本分布。'},
{id:'vp', cat:'volume', term:'收盤價分桶量分布', en:'volume by close price',
 where:[13],
 calc:'與 04 相同的價位桶，把整段顯示期間的成交量加總成橫條；橘色那一條（標「現價」）是目前收盤所在的桶。',
 read:'量特別集中的價位常被稱為「成交密集區」。',
 note:'同樣是以收盤價歸類的估計，不是實際分價成交量。'},
{id:'updown', cat:'volume', term:'多空能量（上漲日／下跌日）', en:'up/down days',
 where:[10],
 calc:'顯示期間內，收盤比前一日上漲的天數、下跌的天數各佔比例；平盤另外計算。',
 note:'這是已經發生的歷史統計，不是預測。',
 now:function(P){ var t=P.tech; return P.bars_count+' 個交易日中 '+t.ups+' 漲 / '+t.downs+' 跌 / '+t.flats+' 平（上漲日 '+f(t.up_ratio,0)+'%）'; }},

/* ===== K 線型態與籌碼分佈（0928a） ===== */
{id:'kline-range', cat:'pattern', term:'主K線圖的區間與開關', en:'chart range · overlays',
 where:[1],
 what:'主K線圖可以切換「近 60／120／250 日」或跟分析天數相同，右側有籌碼成本分佈，上方可以開關型態標註、支撐壓力、布林通道、費波南希。',
 calc:['均線、布林通道在完整歷史上計算，所以切到 250 日時前段不會空白。','費波南希的波段高低點取自目前選的區間；切換區間，回撤價位會跟著變。','開關與區間記在這台電腦的瀏覽器，下次開啟沿用；離線匯出的報告也能切換。'],
 read:'看型態與籌碼分佈建議用 120 日以上：太短的區間樣本少，價值區和 POC 容易被一兩天的大量左右。',
 now:function(){ var k=kstate(); return k?'目前顯示近 '+k.r+' 日'+(k.vp?'，籌碼分佈開啟':'')+(k.pat?'，型態標註開啟':''):null; }},
{id:'candle-pattern', cat:'pattern', term:'K 線型態標註（▲ 多方 ▼ 空方 ◆ 中性）', en:'candlestick patterns',
 where:[1],
 what:'依開高低收自動辨識常見的 K 線型態，標在 K 棒上下：看漲的標在最低價下方（紅色 ▲），看跌的標在最高價上方（綠色 ▼），十字線是中性（黃色 ◆）。',
 calc:['吞：吞噬（多頭或空頭）、晨／暮：晨星／暮星、十：十字線、錘：錘子線、吊：吊人線、流：流星線、三：紅三兵（▲）或黑三鴉（▼）','跳空缺口畫成虛線框（紅＝向上、綠＝向下），一直延伸到價格回補缺口為止','頭肩頂／頭肩底畫出左肩、頭、右肩與黃色虛線頸線；✓＝收盤已突破／跌破頸線，？＝還在等待確認','「走弱／走強之後」＝型態前一天的收盤低於／高於 5 個交易日前，用來分辨錘子線與吊人線這類同形不同義的型態'],
 read:'上方的型態勾選列可以只留想看的型態；滑鼠移到 K 棒上會列出當天的型態與這檔股票的歷史勝率。',
 note:['型態是描述 K 棒形狀的慣例，不是買賣訊號；同一天可能同時出現多空不同的型態。','使用未還原股價，除權息當天的跳空會被當成缺口。'],
 now:function(){ var k=kstate(); if(!k||!k.counts) return null; return '近 '+k.r+' 日：多方 '+k.counts.bull+'、空方 '+k.counts.bear+'、中性 '+k.counts.neutral+' 次'; }},
{id:'pattern-winrate', cat:'pattern', term:'型態歷史勝率（5／10 日上漲機率）', en:'historical hit rate',
 where:[1],
 calc:['把這檔股票最多近 10 年的日K全部掃一遍，找出每一次出現同一個型態的日子。','上漲機率＝那天收盤之後第 5（或 10）個交易日的收盤比較高的次數 ÷ 可以統計的次數；平均＝同期間報酬的平均。','對照基準：全部交易日的 5 日上漲比例。型態的上漲機率要和它比，才知道有沒有比「隨便一天」好。','頭肩型態以收盤突破／跌破頸線那天計；缺口以出現缺口那天計。'],
 read:'例如「5 日上漲機率 42%（近 10 年 n=95，平均 −0.24%）」：過去 95 次出現這個型態後，5 天後比較高的有 42%，平均跌 0.24%。',
 note:['只用這一檔自己的歷史、未還原股價，不含手續費與稅；n 少於 20 時在說明表裡以淡色顯示。','相鄰的型態會重疊、市場狀態會變，歷史比例不能拿來預測下一次。','第一次分析一檔股票時會多抓一次近 10 年的日K（FinMind），之後只補新的日子；證交所來源只用已抓到的期間。'],
 now:function(P){ var p=P.patterns; if(!p||!p.baseline||!p.baseline.n5) return null; return '統計期間 '+p.span.label+'（'+p.span.bars+' 個交易日），全部交易日 5 日上漲 '+f(p.baseline.up5,0)+'%'; }},
{id:'engulfing', cat:'pattern', term:'吞噬（多頭吞噬／空頭吞噬）', en:'engulfing',
 where:[1],
 calc:['多頭吞噬：前 5 日走弱，前一根是黑K，今天是紅K，而且今天的實體（開到收）完全包住昨天的實體。','空頭吞噬：前 5 日走強，前一根是紅K，今天是黑K並包住昨天的實體。'],
 read:'常被視為短線方向可能反轉的訊號，要搭配量能與位置（例如是否在支撐或壓力附近）一起看。'},
{id:'star', cat:'pattern', term:'晨星／暮星', en:'morning · evening star',
 where:[1],
 calc:['晨星（三根）：下跌中先出現長黑K，接著一根實體很小、位置更低的K，第三根紅K收過第一根實體的一半。','暮星：上漲中的長紅K → 小實體、位置更高的K → 收破第一根實體一半的黑K。','「長」＝實體至少是前 10 根平均實體；「小」＝不到第一根實體的 35%。']},
{id:'doji', cat:'pattern', term:'十字線', en:'doji',
 where:[1],
 calc:'實體（開盤與收盤的差）不到當天最高最低振幅的 10%，而且振幅至少 0.4%。',
 read:'代表多空力量接近平衡；出現在長期上漲或下跌之後，常被解讀為動能減弱。十字線本身不分多空。'},
{id:'hammer', cat:'pattern', term:'錘子線／吊人線／流星線', en:'hammer · hanging man · shooting star',
 where:[1],
 calc:['錘子線：前 5 日走弱後，下影線至少是實體 2 倍、也佔振幅一半以上，上影線很短（≤ 振幅 15%）。','吊人線：形狀和錘子線一樣，但出現在前 5 日走強之後。','流星線：前 5 日走強後，上影線至少是實體 2 倍、下影線很短。'],
 read:'長下影線表示盤中曾被賣低、收盤又被買回；長上影線表示曾被買高、又被賣回。同樣的形狀在不同位置意義不同。'},
{id:'three-soldiers', cat:'pattern', term:'紅三兵／黑三鴉', en:'three white soldiers · three black crows',
 where:[1],
 calc:['紅三兵：連續 3 根紅K、收盤一天比一天高，每根都開在前一根的實體之內，而且都收在接近最高價（上影線不到實體的 40%）。','黑三鴉：連續 3 根黑K、收盤一天比一天低，條件相反。','連續 4 根以上時只記第一次。']},
{id:'gap', cat:'pattern', term:'跳空缺口與回補', en:'price gap',
 where:[1],
 calc:['向上跳空：今天最低價 > 昨天最高價，而且缺口 ≥ 前一日收盤的 0.5%；缺口範圍是昨天最高價～今天最低價。','向下跳空：今天最高價 < 昨天最低價，範圍是今天最高價～昨天最低價。','回補：之後價格回到缺口的另一側（向上缺口：最低價 ≤ 缺口下緣）。虛線框畫到回補那天為止；還沒回補的框延伸到最新一天。'],
 read:'尚未回補的向上缺口常被當成支撐、向下缺口當成壓力；圖下方的摘要會列出還沒回補的缺口。',
 note:'除權息當天因為參考價下調，常出現「假缺口」，請配合除權息標記判斷。'},
{id:'head-shoulders', cat:'pattern', term:'頭肩頂／頭肩底與頸線', en:'head and shoulders',
 where:[1],
 calc:['先找出轉折點：左右各 5 根 K 棒內的最高點與最低點。','頭肩頂：連續三個高點中間最高（頭），兩側（肩）高度相近，兩個低點連成頸線；右肩之後 40 根內收盤跌破頸線才算確認（✓）。','頭肩底：三個低點中間最低，兩個高點連成頸線，收盤突破頸線才確認。','還在等待突破、價格也沒有超過頭部的，標「？」；價格超過頭部就不再視為頭肩型態。'],
 read:'頸線突破後，常見的說法是之後的波動幅度可能接近「頭到頸線」的距離，但這只是經驗法則。',
 note:'型態辨識用固定規則，和人工畫線不一定相同；樣本通常很少，歷史勝率僅供參考。'},
{id:'volume-profile', cat:'pattern', term:'籌碼成本分佈（成交量分佈）', en:'volume profile',
 where:[1],
 what:'主K線圖右側的橫條：把目前區間每一天的成交量，平均分攤到那天最低價～最高價之間的價位，再依價位加總，看哪些價格累積最多成交。',
 calc:['紅色＝收紅K（收盤 ≥ 開盤）那幾天的量，綠色＝收黑K的量。','價位分成 22～48 格（依圖的高度）；用滑鼠滾輪縮放 K 棒時，會用可見的那一段重新計算。'],
 read:'成交很集中的價位代表很多人在那附近買賣，價格回到那裡時常出現拉鋸；成交稀少的價位，價格比較容易快速通過。',
 note:'這是用日K估計的，不是逐筆分價成交，也不是真正的持股成本。',
 now:function(){ var k=kstate(); return k&&k.vp?'近 '+k.r+' 日 POC '+f(k.vp.poc)+'，價值區 '+f(k.vp.val)+'～'+f(k.vp.vah):null; }},
{id:'value-area', cat:'pattern', term:'POC、價值區、VAH 壓力帶與 VAL 支撐帶', en:'POC · value area',
 where:[1],
 calc:['POC（Point of Control）：成交量最多的那一格價位，圖上用黃色虛線橫貫整張圖。','價值區：從 POC 開始，每次往上或往下加入量比較多的那一格，直到涵蓋總成交量的 70%；圖上是淺藍色帶。','VAH＝價值區上緣（壓力帶）、VAL＝價值區下緣（支撐帶）。'],
 read:'收盤在價值區內代表價格還在「多數人成交」的區間；站上 VAH 常被解讀為突破密集區，跌破 VAL 則相反。圖下方的摘要會寫出收盤在價值區的哪一側。',
 now:function(P){ var k=kstate(); if(!k||!k.vp) return null; var c=P.quote.close; return '收盤 '+f(c)+(c>k.vp.vah?' 在價值區上方':c<k.vp.val?' 在價值區下方':' 在價值區內'); }},

/* ===== 法人與信用交易 ===== */
{id:'inst', cat:'chip', term:'三大法人買賣超', en:'institutional net buy/sell',
 where:[8,15,'raw'],
 calc:['外資（含外資自營商）、投信、自營商（自行買賣＋避險）各自的「買進股數 − 賣出股數」，換算成張。','正值＝買超，負值＝賣超；三者都有資料時才算「三大法人合計」。'],
 read:'08 是最多近 30 個交易日的堆疊柱狀圖，加上近 5 日明細表；15 是最新一日的明細。',
 note:['這是公開的法人合計數字，不等於「主力」；沒有券商分點資料就無法辨識實際主力。','證交所來源只有上市股票；上櫃股票請用 FinMind。'],
 now:function(P){ var l=P.chip&&P.chip.last; if(!l) return '未取得三大法人資料';
   return l.date+'：外資 '+sg(l.foreign,0)+'、投信 '+sg(l.trust,0)+'、自營商 '+sg(l.dealer,0)+'，合計 '+sg(l.total,0)+' 張'+(P.chip.stale?'（落後股價）':''); }},
{id:'inst-sum', cat:'chip', term:'法人近 5 日／近 20 日', en:'5-day · 20-day net',
 where:[8,12,18,'cmp','filter'],
 calc:'依股價的交易日對齊，把三大法人合計買賣超加總；期間內任何一天缺資料就不顯示合計（改寫「取得 x/5 日」）。',
 read:'篩選「法人近 5 日買超」＝近 5 日合計大於 0。',
 now:function(P){ var c=P.chip; if(!c||!c.has_data) return '未取得三大法人資料';
   return '近 5 日 '+(ok(c.net5)?sg(c.net5,0)+' 張':'資料不足（'+c.coverage5+'/5 日）')+'、近 20 日 '+(ok(c.net20)?sg(c.net20,0)+' 張':'資料不足（'+c.coverage20+'/20 日）'); }},
{id:'inst-cum', cat:'chip', term:'籌碼異動摘要與累計線', en:'cumulative net',
 where:[15],
 calc:'上方表格是最新一日各法人買賣超；下方小圖是顯示期間內三大法人合計的逐日累加，遇到缺漏日就停止，不跨過缺口連線。',
 read:'累計為正時線用漲色、為負時用跌色；標題顯示法人資料日期，比股價舊時標「落後股價」，近 20 日有缺漏時也會註明。'},
{id:'margin', cat:'chip', term:'融資餘額／融券餘額', en:'margin · short balance',
 where:[16],
 what:'融資是投資人向券商借錢買股票，餘額是還沒償還的張數；融券是向券商借股票來賣，餘額是還沒買回的張數。',
 calc:'單日增減＝今日餘額 − 前一日餘額（張）。',
 read:'融資增加常被解讀為散戶偏多、融券增加為看空或避險；本工具只列出數字，沒有拿來評分。16 的第三格是量比。',
 note:'部分上櫃或特殊標的沒有這個欄位；日期比股價舊時標「落後股價」。',
 now:function(P){ var m=P.margin; if(!m) return '未取得融資融券資料';
   return m.date+'：融資 '+f(m.margin_bal,0)+' 張（'+sg(m.margin_chg,0)+'）、融券 '+f(m.short_bal,0)+' 張（'+sg(m.short_chg,0)+'）'; }},
{id:'chip-score', cat:'chip', term:'法人籌碼分', en:'chip score',
 where:[2,3,17],
 calc:['從 50 分開始','＋ 近 5 日法人合計 ÷ (20 日均量 × 5) × 100，上下限 ±35','＋ 近 20 日法人合計 ÷ (20 日均量 × 20) × 100，上下限 ±15','最後限制在 0～100'],
 read:'意思是「法人買賣超佔同期成交量的比例」：近 5 日法人買超佔成交量 10%，就大約加 10 分。',
 note:'近 20 日任何一天缺三大法人資料就不計分（顯示無資料），綜合分會改用其他三項重新分配權重。',
 now:function(P){ var s=P.scores.chip; return ok(s)?'籌碼分 '+f(s,0)+' 分':'籌碼分：無資料（近 20 日法人 '+P.chip.coverage20+'/20 日）'; }},

/* ===== 評分與研判 ===== */
{id:'trend-score', cat:'score', term:'趨勢分', en:'trend score',
 where:[3],
 calc:['均線排列 40 分：多頭排列 40、MA5 > MA10 但未完全多頭 25、空頭排列 5、其他 15','收盤在 MA20 之上 30 分，否則 8 分','收盤在 MA60 之上 30 分，否則 8 分','三項加總後換算成 100 分；缺均線的項目不計入分母'],
 now:function(P){ return '趨勢分 '+f(P.scores.trend,0); }},
{id:'mom-score', cat:'score', term:'動能分', en:'momentum score',
 where:[3],
 calc:['OSC 40 分：為正且擴大 40、為正但縮小 28、為負但改善 18、為負且擴大 6','RSI 35 分：50～70 得 35、40～50 得 26、70～80 得 20、其他 10','K > D 得 25 分，否則 9 分','加總後換算成 100 分'],
 now:function(P){ return '動能分 '+f(P.scores.momentum,0); }},
{id:'tech-score', cat:'score', term:'技術分', en:'technical score',
 where:[3,11,17],
 calc:'技術分＝趨勢分 × 50% ＋ 動能分 × 50%（缺一項時只用另一項）。',
 now:function(P){ return '技術分 '+f(P.scores.tech,0); }},
{id:'overall', cat:'score', term:'綜合分', en:'overall score',
 where:[2,3,17,18,'cmp','filter','sim'],
 calc:['綜合分＝趨勢 32% ＋ 動能 28% ＋ 籌碼 25% ＋ 量價 15%','取不到的項目不計入，其餘項目的權重等比例放大'],
 read:'03 雷達中央的大字就是綜合分。分數越高，代表越多條規則同時偏多；比較表可以用「最低綜合分」篩選，交易模擬可以用它當進場門檻。',
 note:'綜合分是規則分，不是勝率；布林通道與 ADX 都沒有加入。',
 now:function(P){ var s=P.scores; return '綜合分 '+f(s.overall,1)+'（趨勢 '+f(s.trend,0)+'、動能 '+f(s.momentum,0)+'、籌碼 '+(ok(s.chip)?f(s.chip,0):'無資料')+'、量價 '+f(s.volume,0)+'）'; }},
{id:'radar3', cat:'score', term:'多維度判讀雷達', en:'score radar',
 where:[3],
 calc:'六個軸：趨勢、動能、籌碼、量價、位階（＝60 日位階）、技術，都是 0～100；中央大字是綜合分。',
 read:'面積越大、越平均，代表各面向同時偏多；某一軸特別凹，就是目前的弱項。',
 note:'無資料的軸畫在 0，並在圖下方註明「無資料：…」。'},
{id:'radar5', cat:'score', term:'技術風險雷達', en:'technical risk radar',
 where:[5],
 calc:'六個軸：RSI14、K 值、D 值、60 日位階、ATR 波動（ATR% × 10）、MA20 乖離（50 ＋ 乖離 × 3），都換算成 0～100。',
 read:'越往外圈＝越偏高檔、波動越大或離月線越遠。它描述「現在的位置有多熱」，不是發生風險的機率。'},
{id:'risk9', cat:'score', term:'風險監測', en:'risk monitor',
 where:[9],
 calc:'五條橫條：RSI14（以 30／70 分區）、K 值與 D 值（20／80）、20 日位階與 60 日位階（25／75）。',
 read:'藍＝低檔區、黃＝中性、紅＝高檔區。只描述指標目前的位置，不預測方向。'},
{id:'gauge11', cat:'score', term:'技術狀態綜合儀表', en:'gauges',
 where:[11],
 calc:'四個環：RSI14、K 值、D 值（顏色規則同 09 風險監測）和技術分（藍色深淺）。',
 read:'環越滿數值越高；環中間的數字就是數值本身。'},
{id:'lamp12', cat:'score', term:'動能燈號', en:'signal lamps',
 where:[12],
 calc:['趨勢：多頭排列綠燈、空頭排列紅燈、其他黃燈','動能：OSC 為正綠燈、為負紅燈','籌碼：近 5 日法人買超綠燈、賣超紅燈、持平或資料不足灰燈','乖離：|MA20 乖離| ≤ 5% 綠燈、5～10% 黃燈、> 10% 紅燈','量價：量價分 > 50 用漲色、< 50 用跌色、等於 50 或無資料灰色'],
 note:'燈色一定搭配文字，不單靠顏色表意。'},
{id:'score17', cat:'score', term:'評分總覽', en:'score overview',
 where:[17],
 calc:'技術、籌碼、綜合三個分數環；顏色是單一藍色的深淺：≥ 75 最亮、60～75、45～60、< 45 最暗。',
 note:'刻意不用紅綠，避免和「紅漲綠跌」混淆。'},
{id:'verdict', cat:'score', term:'進場態度／戰略綜合研判', en:'verdict',
 where:[2,18],
 calc:['綜合分無資料 → 資料不足','「已近壓力」（風險報酬比 < 1，或 60 日位階 ≥ 92）且綜合分 ≥ 58 → 強勢但已近壓力．不追價','綜合分 ≥ 72，且籌碼分 ≥ 50（或沒有籌碼分）→ 偏多．可留意回檔','綜合分 ≥ 58 → 中性偏多．不追價','綜合分 ≥ 42 → 中性．等待','其他 → 偏空．觀望'],
 read:'由上往下依序判斷，符合第一條就停。02 上方另有提示條：指標筆數不足、籌碼分無資料或本次更新有缺漏時，會顯示「資料待補」。',
 note:'這是規則輸出的文字，不是投資建議。',
 now:function(P){ return '目前：'+P.plan.verdict; }},
{id:'plan', cat:'score', term:'參考進場區／停損參考／首目標／風險報酬比', en:'trade plan',
 where:[2,18],
 calc:['參考進場區＝收盤 ± 0.25 × ATR','停損參考＝「收盤 − 1 × ATR」與「近 10 日最低價」取較低者','首目標＝60 日高點（即 60 日壓力）','風險報酬比＝(首目標 − 進場區上緣) ÷ (進場區上緣 − 停損)；首目標不高於進場區上緣時不計算'],
 read:'風險報酬比 2＝到首目標的空間是到停損的兩倍；小於 1 表示離壓力已經很近。',
 note:'這是機械式換算，沒有考慮跳空、流動性、手續費與稅，不是買賣建議。',
 now:function(P){ var p=P.plan; return '進場區 '+f(p.entry_lo)+' ～ '+f(p.entry_hi)+'、停損 '+f(p.stop)+'、首目標 '+f(p.target)+'、風險報酬比 '+f(p.rr); }},
{id:'data-avail', cat:'score', term:'資料可用度', en:'data coverage',
 where:[14],
 calc:['價量＝顯示期間取得的交易日數 ÷ 分析天數','法人＝顯示期間有完整三大法人的天數 ÷ 分析天數','融資券＝最新一筆是否與股價同一天且欄位齊全（同日完整／落後或缺值／無資料）','指標所需筆數：MA60、KD、MACD、RSI、ATR、20 日成交均價都算得出來才算「足夠」'],
 now:function(P){ var a=P.avail; return '價量 '+a.price_days+'/'+a.need_days+' 日、法人 '+a.chip_days+'/'+a.need_days+' 日、融資券'+(a.margin_current?'同日完整':a.margin?'落後或缺值':'無資料')+'、指標筆數'+(a.indicators_ready?'足夠':'不足'); }},

/* ===== 比較表與篩選 ===== */
{id:'cmp-cols', cat:'compare', term:'自選股比較表的欄位', en:'comparison table',
 where:['cmp'],
 calc:['收盤價、漲跌幅、成交量、量比、法人近 5／20 日、相對大盤 20 日、綜合分：定義同各指標。','布林寬度%、布林 %B、寬度百分位、布林狀態：見布林通道各條。','ADX14、＋DI、−DI、量價方向：見 ADX／DMI 與量價分。','股價日期：各檔最新交易日；日期不同時表格下方會提醒，漲跌幅就不是同一天。','來源：資料來源與這次的取得方式（見「資料取得方式」）。'],
 read:'點欄位標題排序（再點一次反向），點股票列切換下方詳細圖表；缺值固定排在有效數值之後。'},
{id:'cmp-status', cat:'compare', term:'資料狀態標記', en:'data flags',
 where:['cmp'],
 calc:['價量 x/y 日：取得的交易日少於分析天數','法人 x/20 日：近 20 日三大法人不完整，籌碼分不計','融資券無資料／融資券日期落後／融資券欄位缺漏','指標筆數不足：歷史太短，部分指標算不出來','更新有缺漏：這次有資料集沒抓到，已沿用舊資料或留空，稍後會自動重試','除權息未完整取得','大盤基準不足：算不出相對大盤','近 60 日有除權息：均線等指標含除權息缺口'],
 read:'全部都沒有時顯示「資料齊全」。',
 now:function(P){ var n=P.comparison_notes||[]; return n.length?n.join('、'):'資料齊全'; }},
{id:'cmp-filter', cat:'compare', term:'篩選條件', en:'filters',
 where:['cmp','filter'],
 calc:['布林條件：通道收斂、今日突破上軌、今日跌破下軌、收盤在上軌外、收盤在下軌外','最低綜合分：綜合分 ≥ 填入的數字','相對大盤 20 日 > 0','法人近 5 日買超：近 5 日合計 > 0','最低 ADX：ADX14 ≥ 填入的數字','DMI 方向：＋DI 高於 −DI，或 −DI 高於 ＋DI'],
 read:'條件可以同時使用、命名儲存（存在程式資料夾的 filter_presets.json），也能把符合的股票匯出成 CSV。',
 note:'缺值的股票不符合數值條件；等待中或失敗的股票仍會列出，方便知道還缺哪幾檔。'},

/* ===== 回測與交易模擬 ===== */
{id:'bt-table', cat:'bt', term:'規則分回測表', en:'score backtest',
 where:['bt'],
 calc:['用和今天完全相同的規則，逐日重算過去每一天的綜合分（每天只用當天以前的資料，不偷看未來）。','依當天分數分四組：72 分以上、58～72、42～58、未滿 42。','每組統計之後 5 個與 10 個交易日的平均報酬、中位數、上漲比例，並和「全部交易日」基準比較。'],
 read:'高分組的後續報酬明顯高於基準，才表示這套規則在這檔股票、這段期間和後續漲跌同方向。',
 note:['只有這一檔、目前取得的區間；相鄰日子的報酬大幅重疊，實際獨立樣本遠少於表上天數。','沒有計入手續費、交易稅與除權息；至少需要約 75 個交易日才計算。']},
{id:'bt-sim', cat:'bt', term:'交易模擬（次日進場、不重複持倉）', en:'trade simulation',
 where:['sim'],
 calc:['進場條件三選一：綜合分達門檻、布林首次突破上軌、兩者同時成立。','訊號日收盤成立 → 次一交易日開盤買進；持有第 N 個交易日（進場日算第 1 天）收盤賣出；持倉期間忽略新訊號。','買進價＝開盤 × (1 ＋ 滑價) × (1 ＋ 手續費)；賣出價＝收盤 × (1 − 滑價) × (1 − 手續費 − 交易稅)。','預設：門檻 72、持有 5 日、手續費 0.1425%、賣出交易稅 0.3%、滑價 0.05%、要求訊號日法人近 20 日完整。','區間檢查：可只看前 70% 或後 30% 的日子，各段都從空手開始。'],
 note:['不含最低手續費、股數取整與漲跌停無法成交的情況；ETF 等商品請自行調整稅率。','持倉跨除權息時缺少還原資料，會暫停顯示資金績效。']},
{id:'bt-metrics', cat:'bt', term:'淨報酬／每日最大回落／獲利比例／買入持有', en:'simulation metrics',
 where:['sim'],
 calc:['淨報酬＝資金指數從 100 開始的期末值 − 100；未平倉部位以最後一天收盤扣預估賣出成本估值。','每日最大回落＝每日清算淨值從前高下跌的最大幅度（用收盤算，不是盤中最大虧損）。','已平倉獲利比例＝扣成本後報酬 > 0 的已平倉筆數 ÷ 已平倉筆數。','同股買入持有＝區間第二天開盤買進、持有到最後一天收盤，同樣扣成本，作為比較基準。'],
 note:'完成交易少於 20 筆時樣本很有限；反覆調整參數容易「過度配適」，後 30% 區間不能當作獨立驗證。'},

/* ===== 全球市場與匯率 ===== */
{id:'fx', cat:'macro', term:'美元兌台幣（台銀即期中價）', en:'USD/TWD',
 where:['macro'],
 calc:'即期中價＝(台灣銀行即期買入匯率 ＋ 即期賣出匯率) ÷ 2；沒有即期報價的日子不列入，不用現金匯率替代。',
 read:'數字變大＝1 美元可以換更多台幣＝台幣貶值；變小＝台幣升值。',
 now:function(P,M){ var s=macroSeries(M,'USDTWD'); return s&&s.available?s.to+' 即期中價 '+f(s.latest,3)+'，20 日變動 '+(s.d20?sg(s.d20.pct)+'%':'—'):null; }},
{id:'idx', cat:'macro', term:'台股加權／S&P 500／那斯達克／日經 225', en:'market indices',
 where:['macro'],
 what:'四個市場的大盤價格指數（不含息）：台股加權指數（TAIEX）、美國標準普爾 500、那斯達克綜合指數、日經 225。',
 calc:['主要來源是 FinMind；美、日指數在 FinMind 沒有資料或日期較舊（超過 7 天）時改查 Stooq。','在進階設定勾選「改用 Yahoo 財經」後，FinMind 與 Stooq 都沒有新資料時才再查 Yahoo 財經，來源標示為「Yahoo 財經（非官方）」；還在交易中的當天不採用。','每個序列只選一個來源，不把不同來源拼接起來算漲跌。'],
 read:'每張小卡顯示最新點數、1／5／20 日變動、資料日期與來源。',
 note:'這是背景資訊，沒有加入任何個股評分。',
 now:function(P,M){ if(!M||!M.series) return null;
   return M.series.filter(function(s){return s.kind==='index';}).map(function(s){return s.name+' '+(s.available?f(s.latest,0)+'（20 日 '+(s.d20?sg(s.d20.pct)+'%':'—')+'）':'無資料');}).join('、'); }},
{id:'idx100', cat:'macro', term:'大盤走勢（起點＝100）', en:'indexed to 100',
 where:['macro'],
 calc:'每條線以自己在畫面上的第一個交易日為 100，之後的值＝當日指數 ÷ 起點指數 × 100；105 代表比起點漲 5%。',
 note:'台、美、日假日不同，各線各畫各的，不對齊也不補值；起點日期可能不同，不宜直接當成同期績效排名。'},
{id:'macro-chg', cat:'macro', term:'1 日／5 日／20 日變動、日期較舊', en:'changes',
 where:['macro'],
 calc:['變動＝最新值與該序列往前第 1、5、20 個「有報價的日子」相比的漲跌幅（各市場依自己的交易日）。','日期較舊＝最新資料距今超過 7 個日曆天（日曆天差距，不是缺少的交易日數）。']},

/* ===== 市場掃描與族群（20260925a） ===== */
{id:'market-data', cat:'market', term:'全市場資料與更新', en:'market-wide data',
 where:['scan','rank','etf','sector'],
 what:'「市場掃描」一次看上市櫃全部股票。資料是證交所與櫃買中心每天收盤後公布的行情與三大法人，產業別取自 FinMind 的股票清單。',
 calc:['上市行情：證交所每日收盤行情（不含權證、牛熊證）；上櫃行情：櫃買中心每日收盤行情。','三大法人：上市用證交所 T86、上櫃用櫃買中心三大法人買賣明細，只抓最近 10 個交易日。','第一次掃描要逐日下載約 90 個平日（60 日期間），每個請求間隔約 2 秒以免被擋，約需 3～4 分鐘；下載過的日子存在本機快取，之後每天只補新的一天。','重新打開頁面時先用本機快取顯示上次的結果，按「更新掃描」才會連網。'],
 note:['這是收盤後資料，不是盤中即時行情。','來源網站改版造成格式看不懂時，程式會把回應開頭記在程式資料夾的 market_debug.log（不含 Token），方便回報。'],
 now:function(P,M,K){ return K?'資料日期 '+K.latest_date+'，上市 '+K.counts['上市']+' 檔、上櫃 '+K.counts['上櫃']+' 檔，共 '+K.trading_days+' 個交易日':null; }},
{id:'liquidity', cat:'market', term:'流動性門檻（20 日均成交值）', en:'liquidity filter',
 where:['scan','rank','sector'],
 calc:'近 20 個交易日每天成交金額的平均。預設 ≥ 3,000 萬元，可改 1,000 萬、1 億或不限。',
 read:['選股清單、漲幅排行只列達到門檻的一般股票，避免成交稀少的股票一點點量就衝上榜。','族群平均先用達門檻的成員；達門檻的不足 3 檔時才改用全部成員。','綜合強勢分的百分位也只在達門檻的股票之間比較。'],
 now:function(P,M,K){ return K?'目前門檻 '+(K.min_amount?(K.min_amount/1e4).toLocaleString('zh-TW')+' 萬元':'不限')+'，達標的一般股票 '+K.counts.universe+' 檔':null; }},
{id:'scan-score', cat:'market', term:'綜合強勢分（市場掃描）', en:'scan score',
 where:['scan'],
 calc:['動能 50 分：20 日報酬在所有達門檻股票中的百分位 × 30 ＋ 5 日報酬百分位 × 20','趨勢 25 分：收盤在 MA20 之上且 MA20 比 5 天前高 15 分；MA5 > MA10 > MA20 再加 10 分','量能 10 分：今天上漲時，(量比 − 1) × 10，最多 10 分（量比 2 倍以上滿分）','籌碼 15 分：法人近 5 日合計買超得 15 分；沒有法人資料時這 15 分不計，其餘換算成 100 分'],
 read:'分數越高＝近期漲得多、站在均線上、放量、法人也在買。「綜合強勢」清單依這個分數排出前 40 名。',
 note:'和 18 格裡的「綜合分」是不同的規則：這裡是用來在全市場裡挑出相對強的股票，18 格的綜合分是單一股票的多面向評分。兩者都不是勝率。',
 now:function(P,M,K){ if(!K||!K.screens.strong.length) return null; var m={}; K.stocks.forEach(function(s){m[s.code]=s;});
   return '今天前 3 名：'+K.screens.strong.slice(0,3).map(function(c){return c+' '+m[c].name+'（'+f(m[c].scan_score,0)+' 分）';}).join('、'); }},
{id:'screen-rules', cat:'market', term:'選股清單的條件', en:'screens',
 where:['scan'],
 calc:['綜合強勢：綜合強勢分由高到低','放量突破：今日上漲 ≥ 3%、量比 ≥ 2 倍，且收盤高於前 20 個交易日的最高收盤','站上月線：今天收盤在 MA20 之上，前一天收盤還在 MA20 之下','創 60 日新高：收盤 ≥ 近 60 個交易日的最高收盤','法人連買：三大法人合計連續買超 ≥ 3 個交易日（依連買天數、再依 5 日合計排序）','投信連買：投信連續買超 ≥ 3 個交易日','跌深反彈：近 20 日下跌 ≥ 15%，今天上漲 ≥ 3%','強勢族群領頭：「領漲」象限的族群中，20 日報酬前 3 名的成員'],
 read:'每份清單最多 40 檔，只放達流動性門檻的一般股票（不含 ETF）；點代號載入 18 格分析，勾選多檔可一次比較。',
 note:'這些是把公開資料套進固定條件的篩選結果，不是推薦買進；符合條件之後的漲跌可以用 18 格的「規則分回測」自己檢查。',
 now:function(P,M,K){ return K?K.screen_defs.map(function(d){return d.label+' '+(K.screens[d.key]||[]).length;}).join('、'):null; }},
{id:'mk-tags', cat:'market', term:'清單標記', en:'tags',
 where:['scan','rank','sector'],
 calc:['漲停：今日漲幅 ≥ 9.5%（台股漲跌幅上限 10%）','法人連買 N 日／法人連賣 N 日：三大法人合計連續買超／賣超 2 天以上','投信連買 N 日','60 日新高：收盤創近 60 個交易日新高；突破 20 日高：收盤高於前 20 日最高收盤','站上月線：今天由下往上穿越 MA20','爆量：量比 ≥ 2 倍','多頭排列：MA5 > MA10 > MA20']},
{id:'inst-streak', cat:'market', term:'法人連買／連賣天數', en:'institutional streak',
 where:['scan','sector'],
 calc:['從法人資料的最新一天往回數，三大法人合計「連續同方向」的天數；遇到方向改變、當天沒有資料或剛好 0 就停止。','最多往回看 10 個交易日；「5 日」是最近 5 天合計（任一天缺資料就不顯示）。'],
 note:['法人資料通常傍晚才公布，傍晚前掃描時最新法人日期會比行情早一天，畫面上方會註明。','上櫃法人取不到時，上櫃股票不列入法人相關條件，綜合強勢分的籌碼 15 分改由其他項目分攤。']},
{id:'rank-list', cat:'market', term:'漲幅排行', en:'top movers',
 where:['rank'],
 calc:['今日漲幅／跌幅：用交易所公布的漲跌（對參考價）÷ 參考價，所以除權息當天不會被誤算成大跌。','5 日、20 日漲幅：今天收盤 ÷ 5、20 個交易日前收盤 − 1；那天沒交易就往前最多再找 3 天。','成交值、量比排行：看今天哪些股票成交最熱絡、比平常放大最多。'],
 note:'多日漲幅用未還原的收盤價計算，期間內有除權息時會偏低。'},
{id:'etf-rank', cat:'market', term:'熱門 ETF', en:'ETF ranking',
 where:['etf'],
 calc:['代號 00 開頭的 ETF，可依成交值、今日漲跌、量比、20 日或 60 日漲跌排序。','標記：代號 B 結尾為債券 ETF、L 結尾或名稱含「正2」為槓桿、R 結尾或名稱含「反1」為反向、U 結尾為期貨型。'],
 read:'預設不列槓桿／反向型，勾選「含槓桿／反向」才會出現。',
 note:'槓桿、反向 ETF 追蹤的是「每日」倍數，持有多天的報酬不等於指數報酬的倍數。'},
{id:'sector-rotation', cat:'market', term:'族群輪動（四象限）', en:'sector rotation',
 where:['sector'],
 calc:['每個族群取成員的等權平均報酬：橫軸＝20 日平均報酬（中期），縱軸＝5 日平均報酬（短期）。','右上「領漲」：5 日、20 日都為正；左上「轉強」：20 日仍為負但 5 日轉正；右下「轉弱」：20 日為正但 5 日轉負；左下「落後」：兩者皆負。','泡泡大小＝族群成員 20 日平均成交值的合計（開根號縮放）；每個族群至少要 3 檔有資料才計算。','黃框＝動能加速（見「動能加速度」）；名稱前有 🔔＝3 日內剛換象限。點泡泡會畫出這個族群最近 10 天的移動軌跡。'],
 read:'常見的解讀是族群會沿著「落後 → 轉強 → 領漲 → 轉弱」逆時針輪動，可以用來找「剛轉強」或「還在領漲」的題材，再點進去看成員。',
 note:'等權平均讓小型股和大型股影響一樣大；輪動只是描述過去 5／20 日的相對表現，不保證會照順序繼續走。',
 now:function(P,M,K){ if(!K) return null; var c={}; K.sectors.forEach(function(g){c[g.quadrant]=(c[g.quadrant]||0)+1;});
   return '領漲 '+(c['領漲']||0)+'、轉強 '+(c['轉強']||0)+'、轉弱 '+(c['轉弱']||0)+'、落後 '+(c['落後']||0)+' 個族群'; }},
{id:'quadrant-change', cat:'market', term:'象限轉換提醒（🔔）', en:'quadrant change',
 where:['sector'],
 calc:'用最近 20 個交易日每天的 5 日、20 日平均報酬判斷當天的象限；最新象限和前 3 個交易日中任何一天不同，就標 🔔，並寫出是從哪個象限轉進來。',
 read:'「由落後轉入轉強」「由轉強轉入領漲」是常被關注的輪動；「由領漲轉入轉弱」代表短線開始降溫。',
 note:'象限以 0 為界，報酬在 0 附近來回時會頻繁換象限，要搭配動能加速度與成交值一起看。',
 now:function(P,M,K){ if(!K) return null; var n=0; K.sectors.forEach(function(g){ var h=g.hist; if(!h) return; var q=function(i){var a=h.r5[i],b=h.r20[i];return ok(a)&&ok(b)?(b>=0?(a>=0?1:2):(a>=0?3:4)):0;}; var L=h.r5.length-1; for(var i=L-1;i>=Math.max(0,L-3);i--){ if(q(i)&&q(i)!==q(L)){n++;break;} } }); return n+' 個族群在 3 日內換象限'; }},
{id:'sector-heat', cat:'market', term:'強弱熱力矩陣', en:'strength heatmap',
 where:['sector'],
 calc:['列＝族群、欄＝最近 20 個交易日，格子顏色：紅＝強、綠＝弱，顏色深淺依全部格子的最大幅度自動縮放。','當日漲跌：族群成員當天漲跌的等權平均；5 日報酬：當天往前 5 個交易日的平均報酬；相對大盤：當日漲跌 − 全市場（流動性門檻以上的一般股票）平均。'],
 read:'一整列持續偏紅代表族群強勢延續；由綠翻紅的列是正在轉強的族群。'},
{id:'sector-rank', cat:'market', term:'排名變化', en:'rank changes',
 where:['sector'],
 calc:'每天把目前分類裡的族群依 5 日平均報酬排名（第 1 名最強），畫成折線；醒目標示最新排名前 8 的族群。',
 read:'線從下往上爬＝排名快速進步；在前幾名停留很久的是持續強勢的族群。滑鼠移到線上看起點到最新的名次變化。'},
{id:'sector-timeline', cat:'market', term:'象限時間軸', en:'quadrant timeline',
 where:['sector'],
 calc:'每一格是族群在那一天所在的象限（領漲紅、轉強黃、轉弱紫、落後綠）；列依最新象限排序。',
 read:'可以看出輪動的節奏：例如連續幾天由綠變黃再變紅，就是「落後 → 轉強 → 領漲」。',
 note:'20 日報酬需要 21 個交易日的資料，掃描期間選 20 日時只看得到最後幾天。'},
{id:'sector-accel', cat:'market', term:'動能加速度', en:'momentum acceleration',
 where:['sector'],
 calc:'動能加速度＝今天的 5 日平均報酬 − 5 個交易日前的 5 日平均報酬（百分點）。',
 read:'正值＝短線動能變強（例如跌勢趨緩或漲勢加快），負值＝降溫。加速度 ≥ +2 的族群在四象限雷達上會加黃框。',
 note:'加速度只看變化，不看方向：同樣 +3，可能是從 −5% 回到 −2%，也可能是從 +2% 加速到 +5%。'},
{id:'sector-vol', cat:'market', term:'族群波動', en:'volatility',
 where:['sector'],
 calc:'每檔成員先算近 20 日「每日對數報酬」的標準差 × √252 × 100（年化波動 %），族群取成員的中位數。',
 read:'數字越大代表這個族群的股價上下跳得越兇；30% 大約是一般股票的水準。'},
{id:'sector-leaders', cat:'market', term:'代表股與族群成員', en:'leaders · members',
 where:['sector'],
 calc:['代表股：族群裡 20 日平均成交值最大的 5 檔（最常被交易的公司，不一定漲最多）。','點族群名稱或泡泡：列出全部成員，依 20 日報酬排序；「分析前 10 檔」會把成交值最大的 10 檔送進 18 格比較。','「檔數」顯示納入平均的檔數／族群全部檔數。'],
 note:'找不到的代號（下市、代號打錯或當天沒交易）會列在成員清單上方。'},
{id:'themes', cat:'market', term:'官方產業別與概念族群', en:'industries · themes',
 where:['sector'],
 calc:['官方產業別：FinMind 股票清單的產業分類（例如半導體業、航運業）；一檔股票同時有「電子工業」這種大分類和細分類時，取細分類。','概念族群：AI 伺服器、CoWoS、散熱、矽智財等題材分組，預設是程式作者整理的範例。'],
 read:'按「族群輪動」右上的「自訂族群」：每列一個族群，成分股用逗號分隔，只填代號也可以（會自動帶入名稱）。可以匯出／匯入 JSON 備份或分享；按「儲存並重算」後存在程式資料夾的 themes.json；「還原預設」要按兩次確認，原本的自訂檔會改名成 themes.json.bak 保留。',
 note:'題材成員是人工整理的，公司業務會變，請依自己的判斷維護。'},
{id:'price-alert', cat:'market', term:'到價警示', en:'price alerts',
 where:['alert','toolbar'],
 calc:['可設上限價、下限價、單日漲跌幅門檻（任填一項以上）。','觸發：當天盤中最高價 ≥ 上限價、最低價 ≤ 下限價，或漲跌幅絕對值 ≥ 門檻。','報價來自最近一次市場掃描；沒掃描時改用剛分析過的個股資料。'],
 read:'有新觸發時「到價警示」分頁會出現紅色數字；按「全部標為已讀」後，同一天不再算新警示。18 格上方的「設定到價警示」會預填收盤價 ±10%。',
 note:'這是收盤後比對，不是盤中即時推播；警示存在程式資料夾的 alerts.json，最多 100 檔。'},
{id:'paper-trade', cat:'market', term:'模擬持倉與損益', en:'paper trading',
 where:['paper','toolbar'],
 calc:['成本＝買進價 × 股數 × (1 ＋ 手續費 0.1425%)','市值＝現價 × 股數 × (1 − 手續費 − 交易稅)；交易稅股票 0.3%、ETF 0.1%','損益＝市值 − 成本；報酬＝市值 ÷ 成本 − 1','模擬賣出後移到「已平倉」，以賣出價計算已實現損益'],
 read:'張數可填小數（0.001 張＝1 股）記錄零股。現價取最近一次市場掃描或個股分析的收盤；沒有報價時標「待報價」。',
 note:'只是紀錄，不會下單；沒有計入最低手續費、券商折扣與股利。資料存在程式資料夾的 portfolio.json。'},

{id:'diagnose', cat:'market', term:'連線檢查', en:'connection check',
 where:['scan'],
 what:'市場掃描抓不到資料時，逐一連線證交所、櫃買中心（新舊兩種網址）與 FinMind，列出每個來源的結果、HTTP 狀態與耗時，以及這台電腦的 Python、OpenSSL 版本與是否設定代理伺服器。',
 read:['SSL 憑證驗證失敗：先確認電腦日期時間正確；公司網路若有會替換網站憑證的防火牆或防毒軟體（SSL 檢查），需要把 twse.com.tw、tpex.org.tw 設為例外。','找不到主機、逾時、代理伺服器錯誤：這台電腦的網路連不到該網站，請先用瀏覽器試開。','連線被拒絕、HTTP 403：可能被防火牆擋下，或網站暫時限制查詢頻率，過一段時間再試。','格式無法辨識：連得上但資料格式改了，請回報檢查結果與 market_debug.log。'],
 note:'20260925b 起關閉了 Python 3.13 預設的 X.509「嚴格模式」：證交所與櫃買的憑證缺少嚴格模式要求的欄位，會出現「Missing Subject Key Identifier」。憑證鏈與網址仍然照常驗證。'},

/* ===== 強力分析（0930b） ===== */
{id:'pw-holders', cat:'power', term:'大戶持股（集保股權分散表）', en:'shareholder distribution',
 where:['power'],
 what:'集保結算所每週公布的「股東持股分級」：把一檔股票的股東依持股張數分成 15 級，列出每一級的人數與占集保庫存的比例。',
 calc:['千張大戶＝持股 1,000 張以上那一級的比例；400 張以上＝第 12～15 級合計；散戶＝50 張以下（第 1～8 級）合計。','股東人數＝合計列的人數；平均每人持股＝集保總股數 ÷ 股東人數。','變化以「週」計：1 週、4 週前相比，單位百分點（pt）。'],
 read:['千張大戶比例上升、股東人數減少：籌碼往大戶集中。','千張大戶比例下降、股東人數增加：籌碼分散到散戶手上。'],
 note:'FinMind 的持股分級資料只開放贊助會員；沒有權限時改用集保開放資料（只有最新一週），程式每週自動記下全市場摘要，幾週後就能看趨勢。大戶也可能是公司派、基金或信託帳戶，不一定是「主力」。'},
{id:'pw-risk', cat:'power', term:'風險指標卡：年化報酬與年化波動率', en:'annualized return / volatility',
 where:['power'],
 calc:['日報酬＝今日收盤 ÷ 昨日收盤 − 1；除權息日改用除權息參考價當分母，不把除息當成下跌。','年化報酬＝近 250 個交易日的報酬連乘，換算成一年 252 個交易日。','年化波動率＝日報酬標準差 × √252。'],
 read:'台股個股的年化波動率常見 25%～45%；超過 45% 或最大回撤深於 −35% 標「高風險」，25% 以下且回撤淺於 −20% 標「低風險」。',
 note:'都是過去一年的歷史統計，不是預測。'},
{id:'pw-sharpe', cat:'power', term:'夏普值、索提諾、卡瑪比、Beta', en:'Sharpe / Sortino / Calmar / beta',
 where:['power'],
 calc:['夏普值＝（日報酬平均 × 252 − 無風險利率 1.5%）÷ 年化波動率','索提諾＝同樣的分子 ÷ 下跌波動（只計負報酬的均方根 × √252）','卡瑪比＝年化報酬 ÷ |最大回撤|','Beta＝個股日報酬對大盤（上市用加權、上櫃用櫃買價格指數）日報酬的迴歸斜率；與大盤相關＝兩者的相關係數','周轉率（日均）＝平均每日成交股數 ÷ 發行股數'],
 read:['夏普值、索提諾大於 1 算不錯，小於 0 表示連無風險利率都沒贏過。','Beta 1.2＝大盤漲跌 1%，它平均漲跌 1.2%；與大盤相關低時 Beta 的參考性也低。']},
{id:'pw-downside', cat:'power', term:'最大回撤、VaR 95%、CVaR 95%', en:'max drawdown / VaR / CVaR',
 where:['power'],
 calc:['回撤＝報酬指數 ÷ 之前最高點 − 1；最大回撤是區間內最深的一次，並列出高點與低點日期。','目前距高點＝最新回撤。','單日 VaR 95%＝過去日報酬由小到大排序的第 5 百分位（歷史模擬法）：20 天裡約有 1 天跌得比它多。','CVaR 95%＝比 VaR 更差的那 5% 日子的平均報酬。'],
 read:'「股價與水下回撤曲線」的綠色區塊越深越寬，代表跌得越深、套得越久。'},
{id:'pw-us', cat:'power', term:'美股連動（隔日相關、同向率）', en:'US market linkage',
 where:['power'],
 what:'美股收盤在台股收盤之後，所以美股「當天」的漲跌，影響的是台股「下一個交易日」。這裡比較費城半導體、那斯達克、輝達、台積電 ADR、蘋果、超微（也可以自己加代號）與這檔股票的關係。',
 calc:['隔日相關＝美股日報酬與台股下一交易日報酬的相關係數；台股休市好幾天時，美股那幾天的報酬連乘。','同日相關＝同一個日曆日的兩邊報酬。','β（隔日）＝美股漲 1%，台股隔日平均漲幾 %（迴歸斜率）。','同向率＝兩邊同漲或同跌的比例（任一邊平盤不算）。','美股大漲 ≥2%／大跌 ≤−2% 隔日：那些日子之後台股的平均報酬與漲（跌）機率。'],
 read:'相關係數 0.1 以下幾乎無關、0.3 以下弱、0.5 以上強。散佈圖的黃點是最近一次，黃色虛線是迴歸線。',
 note:'近一年的歷史統計；美股資料依序用 FinMind、Stooq（進階設定勾選時再用 Yahoo 財經）。'},
{id:'pw-foreign', cat:'power', term:'外資持股比率、投資上限', en:'foreign ownership',
 where:['power'],
 calc:['外資持股比率＝外資及陸資持有股數 ÷ 發行股數（證交所每日公布，FinMind TaiwanStockShareholding）。','5／20／60 日變化＝與 5／20／60 筆資料前相比，單位百分點。','剩餘空間＝投資上限 − 目前持股比率。'],
 read:['20 日減少超過 1 個百分點：外資長線資金撤出；增加超過 1 個百分點：長線資金進駐。','剩餘空間很小時，外資能再買的量有限。'],
 note:'持股比率反映「持有」，三大法人買賣超反映「每天的進出」，兩者可以對照看。'},
{id:'pw-sbl', cat:'power', term:'借券賣出餘額、回補天數、融券餘額', en:'securities borrowing & lending',
 where:['power'],
 calc:['借券賣出餘額：借來的股票已賣出、還沒買回還券的數量（FinMind TaiwanDailyShortSaleBalances，換算成張）。','回補天數＝借券賣出餘額 ÷ 近 20 日平均成交量：假設每天都拿成交量回補，要幾天才補得完。','融券餘額：信用交易的放空（多半是散戶）。'],
 read:['借券賣出餘額 20 日增加兩成以上：法人空方布局升溫。','餘額大量減少：空方回補，常伴隨股價上漲。','回補天數越高，軋空的潛在力道越大，但也代表空方看法較強。'],
 note:'借券賣出也可能是避險或套利（例如 ETF、可轉債），不一定是看空。'},
{id:'pw-daytrade', cat:'power', term:'當沖比率', en:'day-trading ratio',
 where:['power'],
 calc:'當沖比率＝現股當沖成交量 ÷ 當天總成交量（FinMind TaiwanStockDayTrading）；列出最新一天、5 日與 20 日平均。',
 read:'5 日平均超過 40% 標「過熱」：短線資金進出很頻繁，股價容易暴漲暴跌；25%～40% 偏高。'},
{id:'pw-margins', cat:'power', term:'三率（毛利率、營益率、淨利率）與 EPS', en:'margins',
 where:['power'],
 calc:['毛利率＝營業毛利 ÷ 營業收入；營益率＝營業利益 ÷ 營業收入；淨利率＝本期淨利 ÷ 營業收入（都用單季）。','季＝與上一季相比、年＝與去年同一季相比，單位百分點。','EPS（單季）＝基本每股盈餘；近四季合計＝最近四季相加。'],
 read:['三率三升：本業與獲利同時變好；三率三降要留意。','淨利率大增但營益率沒變，多半是業外收益，持續性要打折。'],
 note:'資料來自 FinMind 財報（綜合損益表），約在季後 45～75 天公布；金融股沒有一般的營業收入科目，三率僅供參考。'},
{id:'pw-cash', cat:'power', term:'營業現金流／淨利、自由現金流', en:'cash flow quality',
 where:['power'],
 calc:['現金流量表是年初累計數，這裡換算成單季（第 2 季＝上半年 − 第 1 季，依此類推）。','現金流／淨利（近四季）＝近四季營業活動淨現金流合計 ÷ 近四季稅後淨利合計。','自由現金流（近四季）＝營業現金流 − 取得不動產、廠房及設備（資本支出）。'],
 read:['營業現金流 ≥ 稅後淨利（1 倍以上）：獲利有收到現金，獲利品質佳。','長期低於淨利：獲利可能卡在應收帳款或存貨。','自由現金流為負：賺的錢不夠支應投資，要靠借款或現金部位。']},
{id:'pw-fill', cat:'power', term:'填息（填權息）', en:'dividend recovery',
 where:['power'],
 calc:['填息＝除權息後，收盤價回到除權息前一天的收盤價；填息天數以交易日計，0 天＝除權息當天就填息。','當天／20 日內／60 日內填息比例：分母只算已經過那麼多天（或已填息）的次數。','殖利率＝權息值 ÷ 除權息前一日收盤價；平均現金殖利率只算除息（現金股利）。'],
 read:'60 日內填息比例 80% 以上算填息能力強，60%～80% 普通，60% 以下偏弱；最近一次還沒填息時，會顯示已經過幾天、距離填息價還差多少。',
 note:'資料來自 FinMind 除權息結果表與近 10 年日K；權息值是現金股利與股票股利合計的參考值。'},
{id:'pw-season', cat:'power', term:'季節性（月份勝率）', en:'seasonality',
 where:['power'],
 calc:['每個月的報酬＝該月每日報酬連乘（除權息日用參考價，不把除息當成下跌）。','各月份平均＝近 10 年同一個月的平均報酬；勝率＝那個月上漲的年數比例。','本月還沒結束的月份標 *，不列入統計。'],
 read:'看這檔股票哪幾個月習慣強、哪幾個月習慣弱；樣本只有 10 個左右，單一年份的大漲大跌就能改變平均，只能當參考。'},

/* ===== 資料狀態 ===== */
{id:'xlsx-export', cat:'data', term:'資料 Excel（這次分析的全部股票）', en:'Excel export',
 where:['toolbar','cmp'],
 what:'分析工作台工具列的「資料 Excel」與比較表右上的「全部資料 Excel」：把這次產生圖表的全部股票一次下載成一個 .xlsx 檔，不用一檔一檔下載。',
 calc:['第一張工作表「總覽」：每檔一列，收盤、漲跌幅、綜合分與技術／籌碼分、研判、法人近 5／20 日、相對大盤、布林、ADX、最近的 K 線型態與資料日期。','之後每檔一張工作表（名稱是「代號 名稱」）：分析天數內每天的開高低收、成交量、均線、KD、RSI、ADX／DMI、布林、MACD、三大法人，最後一欄是當天出現的 K 線型態；表格下方附資料來源與日期。','標題列凍結、可以直接篩選；日期存成 Excel 日期，代號保留前導 0（例如 0050）。'],
 read:'「本檔 CSV」仍然可以只下載目前這一檔（和舊版相同的欄位）。取得失敗或還在讀取中的股票不會放進 Excel。'},

{id:'data-check', cat:'data', term:'資料齊全／資料待補（頁首）', en:'data status',
 where:['head'],
 calc:'要同時符合才顯示「資料齊全」：指標筆數足夠、有籌碼分、融資券與股價同日且完整、除權息已確認、有大盤基準、這次更新沒有任何警示；否則顯示「資料待補」。',
 read:'資料待補時，頁首資料列與比較表「資料狀態」會寫出缺的是哪一項。'},
{id:'lag', cat:'data', term:'落後股價', en:'stale data',
 where:[15,16,'head'],
 what:'法人或融資券的最新日期比股價最新日期舊。',
 read:'通常是當天的法人或融資券資料還沒公布（多在傍晚至晚間），過一段時間重新查詢即可補上。'},
{id:'fetch-mode', cat:'data', term:'資料取得方式', en:'fetch mode',
 where:['head','cmp'],
 calc:['使用快取：全部來自本機快取，這次沒有連網查詢','增量更新：只補抓缺少或需要再確認的日期','更新有缺漏：部分資料集這次沒抓到，沿用先前資料或留空，稍後會自動重試','示範資料：合成資料，不是真實行情'],
 now:function(P){ var i=P.fetch_info; if(!i) return null;
   return i.mode==='demo'?'示範資料':i.warnings&&i.warnings.length?'更新有缺漏（'+i.warnings.length+' 則提示，內容見頁首資料列）':i.network_requests?'增量更新（查詢 '+i.network_requests+' 次）':'使用快取'; }}
];

/* ---------- 畫面 ---------- */
var dialog=null, opener=null, flashTimer=null, place=null;   // place：速查點選的圖卡（只顯示那一格用到的名詞）
function payload(){ try{ return window.TWBoard&&TWBoard.payload?TWBoard.payload():null; }catch(e){ return null; } }
function macroData(){ try{ return window.TWBoard&&TWBoard.macro?TWBoard.macro():null; }catch(e){ return null; } }
function marketData(){ try{ return window.TWMarket&&TWMarket.data?TWMarket.data():null; }catch(e){ return null; } }
function kstate(){ try{ return window.TWBoard&&TWBoard.kstate?TWBoard.kstate():null; }catch(e){ return null; } }
function whereText(list){
  return (list||[]).map(function(w){ return typeof w==='number'?CARDS[w]:PLACES[w]; }).filter(Boolean);
}
function block(label, value){
  if(value===undefined||value===null||value==='') return '';
  var body=Array.isArray(value)
    ? '<ul>'+value.map(function(v){return '<li>'+rich(v)+'</li>';}).join('')+'</ul>'
    : rich(value);
  return '<dt>'+label+'</dt><dd>'+body+'</dd>';
}
/* 只允許 <sub>，其他一律跳脫 */
function rich(s){ return esc(s).replace(/&lt;sub&gt;/g,'<sub>').replace(/&lt;\/sub&gt;/g,'</sub>'); }
function nowText(e,P,M,K){
  if(!e.now || (!P && e.cat!=='macro' && e.cat!=='market')) return null;
  try{ var s=e.now(P,M,K); return s?String(s):null; }catch(err){ return null; }
}
function entryHTML(e,P,M,K){
  var where=whereText(e.where), now=nowText(e,P,M,K);
  var who=P?(P.code+' '+(P.name||'')+(P.last_date?'（'+P.last_date+'）':'')):'';
  return '<article class="gl-entry" id="gl-e-'+e.id+'" data-gl-id="'+e.id+'" data-cat="'+e.cat+'" data-where="'+(e.where||[]).join(',')+'" tabindex="-1">'+
    '<h4>'+esc(e.term)+(e.en?'<small>'+esc(e.en)+'</small>':'')+'</h4>'+
    (where.length?'<p class="gl-where">出現在：'+where.map(function(w){return '<span>'+esc(w)+'</span>';}).join('')+'</p>':'')+
    '<dl>'+block('是什麼',e.what)+block('怎麼算',e.calc)+block('怎麼看',e.read)+block('要注意',e.note)+'</dl>'+
    (now?'<p class="gl-now"><b>'+(e.cat==='macro'?'目前市場':e.cat==='market'?'目前掃描結果':'目前 '+esc(who))+'</b>'+esc(now)+'</p>':'')+
    '</article>';
}
function build(){
  if(dialog) return dialog;
  dialog=document.createElement('dialog');
  dialog.id='glossary'; dialog.className='gl';
  dialog.setAttribute('aria-labelledby','gl-title');
  dialog.innerHTML=
    '<div class="gl-head">'+
      '<div class="gl-titles"><h2 id="gl-title">指標名詞解釋</h2><p id="gl-sub"></p></div>'+
      '<label class="gl-search"><span class="gl-sr">搜尋指標</span><input id="gl-q" type="search" maxlength="40" placeholder="搜尋：KD、乖離、融資、布林…" autocomplete="off"></label>'+
      '<button type="button" class="btn gl-close" id="gl-close">關閉 ×</button>'+
    '</div>'+
    '<div class="gl-main">'+
      '<nav class="gl-nav" aria-label="名詞分類">'+
        '<button type="button" data-gl-cat="index" aria-current="true">圖卡速查</button>'+
        CATS.map(function(c){ return '<button type="button" data-gl-cat="'+c[0]+'">'+esc(c[1])+'<span></span></button>'; }).join('')+
      '</nav>'+
      '<div class="gl-body" id="gl-body" tabindex="0"></div>'+
    '</div>';
  document.body.appendChild(dialog);
  dialog.addEventListener('click',function(ev){
    if(ev.target===dialog){ close(); return; }            // 點背景關閉
    var cat=ev.target.closest('[data-gl-cat]');
    if(cat){ jumpCat(cat.dataset.glCat); return; }
    var pl=ev.target.closest('[data-gl-place]');
    if(pl){ showPlace(pl.dataset.glPlace); return; }
    if(ev.target.closest('[data-gl-all]')){ showPlace(null); return; }
  });
  dialog.querySelector('#gl-close').addEventListener('click',close);
  dialog.querySelector('#gl-q').addEventListener('input',applySearch);
  dialog.addEventListener('close',function(){
    document.documentElement.classList.remove('gl-lock');
    if(opener && opener.isConnected) opener.focus();
  });
  dialog.querySelector('#gl-body').addEventListener('scroll',syncNav,{passive:true});
  return dialog;
}
function fill(){
  var P=payload(), M=macroData(), K=marketData(), body=dialog.querySelector('#gl-body');
  var names={}; ENTRIES.forEach(function(e){names[e.id]=e.term;});
  dialog.querySelector('#gl-sub').textContent='共 '+ENTRIES.length+' 項 · '+
    (P?'「目前」數值取自 '+P.code+' '+(P.name||'')+'（'+P.last_date+'）':'載入個股後，各項會附上目前這一檔的數值');
  var index='<section class="gl-sec" data-gl-sec="index"><h3>圖卡速查</h3>'+
    '<p class="gl-tip">看到哪一格看不懂，就點那一格：下方只留下那一格用到的名詞。</p><div class="gl-index">'+
    INDEX.map(function(x){
      var key=String(x[0]), label=placeLabel(key), n=usedIn(key).length;
      var list=(x[2]||[x[1]]).map(function(id){return names[id];}).filter(Boolean);
      return '<button type="button" data-gl-place="'+key+'"><b>'+esc(label)+'<em>'+n+' 項</em></b><span>'+
        esc(list.join('、'))+'</span></button>';
    }).join('')+'</div></section>';
  body.innerHTML='<div class="gl-filter" id="gl-filter" role="status" hidden><span id="gl-filter-text"></span>'+
    '<button type="button" class="btn" data-gl-all>顯示全部名詞</button></div>'+index+CATS.map(function(c){
    var list=ENTRIES.filter(function(e){return e.cat===c[0];});
    return '<section class="gl-sec" data-gl-sec="'+c[0]+'"><h3>'+esc(c[1])+'</h3>'+list.map(function(e){return entryHTML(e,P,M,K);}).join('')+'</section>';
  }).join('')+'<p class="gl-empty" id="gl-empty" hidden>找不到符合的名詞，換個關鍵字試試（例如「均線」「法人」「ATR」）。</p>'+
  '<p class="gl-foot">所有公式與本程式的實際計算一致；這些是整理公開資料的規則，不構成投資建議。</p>';
  CATS.forEach(function(c){
    var n=ENTRIES.filter(function(e){return e.cat===c[0];}).length;
    dialog.querySelector('[data-gl-cat="'+c[0]+'"] span').textContent=n;
  });
  applySearch();
}
function placeLabel(key){ return /^\d+$/.test(key)?CARDS[key]:PLACES[key]; }
function usedIn(key){ return ENTRIES.filter(function(e){ return (e.where||[]).some(function(w){return String(w)===key;}); }); }
function norm(s){ return String(s).toLowerCase().replace(/\s+/g,''); }
function applySearch(){
  var q=norm(dialog.querySelector('#gl-q').value), shown=0;
  dialog.querySelectorAll('.gl-entry').forEach(function(a){
    var hit=(!q || norm(a.textContent).indexOf(q)>=0) &&
            (place===null || a.dataset.where.split(',').indexOf(place)>=0);
    a.hidden=!hit; if(hit) shown++;
  });
  var banner=dialog.querySelector('#gl-filter');
  banner.hidden=place===null;
  if(place!==null) dialog.querySelector('#gl-filter-text').textContent='只顯示「'+placeLabel(place)+'」用到的 '+shown+' 項'+(q?'（並符合搜尋）':'');
  dialog.querySelectorAll('.gl-sec').forEach(function(s){
    if(s.dataset.glSec==='index'){ s.hidden=!!q||place!==null; return; }
    s.hidden=!s.querySelector('.gl-entry:not([hidden])');
  });
  dialog.querySelectorAll('.gl-nav [data-gl-cat]').forEach(function(b){
    var sec=dialog.querySelector('[data-gl-sec="'+b.dataset.glCat+'"]');
    b.hidden=!!(sec&&sec.hidden);
  });
  dialog.querySelector('#gl-empty').hidden=shown>0;
  dialog.querySelector('#gl-q').setAttribute('aria-description',q?'符合 '+shown+' 項':'');
}
function scrollBodyTo(node){
  // .gl-body 是 position:relative，offsetTop 就是在捲動內容裡的位置
  dialog.querySelector('#gl-body').scrollTop=Math.max(0,node.offsetTop-6);
}
function jumpCat(cat){
  var sec=dialog.querySelector('[data-gl-sec="'+cat+'"]');
  if(sec&&!sec.hidden){ scrollBodyTo(sec); markNav(cat); }
}
function showPlace(key){
  place=key===null||key===undefined?null:String(key);
  applySearch();
  dialog.querySelector('#gl-body').scrollTop=0;
  var first=dialog.querySelector('.gl-sec:not([hidden])');
  markNav(first?first.dataset.glSec:'index');
  if(place===null) dialog.querySelector('#gl-q').focus();
  else{ var b=dialog.querySelector('[data-gl-all]'); if(b) b.focus(); }
}
function jumpEntry(id){
  var q=dialog.querySelector('#gl-q');
  if(q.value||place!==null){ q.value=''; place=null; applySearch(); }
  var node=dialog.querySelector('#gl-e-'+id);
  if(!node) return;
  scrollBodyTo(node);
  node.classList.add('gl-hit'); node.focus({preventScroll:true});
  clearTimeout(flashTimer); flashTimer=setTimeout(function(){node.classList.remove('gl-hit');},1600);
  markNav(node.dataset.cat);
}
function markNav(cat){
  dialog.querySelectorAll('.gl-nav [data-gl-cat]').forEach(function(b){
    if(b.dataset.glCat===cat) b.setAttribute('aria-current','true'); else b.removeAttribute('aria-current');
  });
}
function syncNav(){
  var body=dialog.querySelector('#gl-body'), top=body.scrollTop+24, cur='index';
  dialog.querySelectorAll('.gl-sec').forEach(function(s){ if(!s.hidden && s.offsetTop<=top) cur=s.dataset.glSec; });
  markNav(cur);
}
function open(entryId){
  build(); place=null; fill();
  opener=document.activeElement;
  if(!dialog.open){
    document.documentElement.classList.add('gl-lock');
    if(dialog.showModal) dialog.showModal(); else dialog.setAttribute('open','');
  }
  if(entryId) jumpEntry(entryId);
  else{ dialog.querySelector('#gl-body').scrollTop=0; markNav('index'); dialog.querySelector('#gl-q').focus(); }
}
function close(){
  if(!dialog) return;
  if(dialog.close) dialog.close(); else dialog.removeAttribute('open');
}
function bind(){
  document.querySelectorAll('[data-glossary-open]').forEach(function(b){
    if(b.dataset.glBound) return; b.dataset.glBound='1';
    b.addEventListener('click',function(ev){ ev.preventDefault(); ev.stopPropagation(); open(b.dataset.glossaryOpen||''); });
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bind); else bind();

window.TWGlossary={open:open, close:close, entries:ENTRIES, categories:CATS, cards:CARDS, index:INDEX};
})();
