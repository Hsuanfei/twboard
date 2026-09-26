# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
import csv
import io
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import twboard as T
import twcache as C
import twserve as S


class BollingerTests(unittest.TestCase):
    def test_known_window_population_sd(self):
        b=T.bollinger(list(range(1,21)))
        self.assertEqual(b['mid'][:19],[None]*19)
        self.assertEqual(b['mid'][-1],10.5)
        self.assertAlmostEqual(b['upper'][-1],10.5+2*math.sqrt(33.25))
        self.assertAlmostEqual(b['lower'][-1],10.5-2*math.sqrt(33.25))
        self.assertAlmostEqual(b['percent_b'][-1],(20-b['lower'][-1])/(4*math.sqrt(33.25)))

    def test_constant_price_no_division_by_zero_or_false_squeeze(self):
        b=T.bollinger([100]*160)
        self.assertEqual(b['width'][-1],0)
        self.assertIsNone(b['percent_b'][-1])
        self.assertEqual(b['width_rank'][-1],50)
        self.assertFalse(b['squeeze'][-1])
        self.assertFalse(b['break_up'][-1])
        self.assertFalse(b['break_down'][-1])

    def test_crossings_not_every_day_above(self):
        b=T.bollinger([100]*140+[120,120])
        self.assertTrue(b['break_up'][-2])
        self.assertFalse(b['break_up'][-1])
        self.assertGreater(b['percent_b'][-1],1)
        low=T.bollinger([100]*140+[80])
        self.assertTrue(low['break_down'][-1])
        self.assertLess(low['percent_b'][-1],0)

    def test_squeeze_and_no_future_data(self):
        prices=[100+(-1)**i*10 for i in range(145)]+[100+(-1)**i*.1 for i in range(20)]
        full=T.bollinger(prices)
        self.assertTrue(full['squeeze'][-1])
        self.assertIsNone(full['squeeze'][137])
        self.assertIsNotNone(full['squeeze'][138])
        for size in (45,139,153):
            cut=T.bollinger(prices[:size])
            for key in full:self.assertEqual(cut[key][-1],full[key][size-1])

    def test_display_window_independent_and_csv(self):
        raw=T.fetch_demo('TEST',days=200,seed=7)
        a=T.analyse('TEST',raw,30);b=T.analyse('TEST',raw,120)
        self.assertEqual(a['bollinger'],b['bollinger'])
        self.assertEqual(a['series']['bb_upper'],b['series']['bb_upper'][-30:])
        rows=list(csv.DictReader(io.StringIO(S.to_csv(a).lstrip('\ufeff'))))
        self.assertAlmostEqual(float(rows[-1]['布林上軌2σ']),a['bollinger']['upper'])
        self.assertEqual(a['scores'],b['scores'])


class DataFixTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.old=C.CACHE_DIR;C.CACHE_DIR=Path(self.tmp.name)
    def tearDown(self):
        C.CACHE_DIR=self.old;self.tmp.cleanup()
    def test_event_range_extension_both_ends_and_reuse(self):
        events=[{'date':'2026-01-10','stock_or_cache_dividend':'除息'}, {'date':'2026-02-07','stock_or_cache_dividend':'除息'}]
        calls=[]
        def get(url,params=None,**kw):
            calls.append((params['start_date'],params['end_date']))
            return {'status':200,'data':[e for e in events if params['start_date']<=e['date']<=params['end_date']]}
        with patch.object(T,'http_get_json',side_effect=get),C.operation():
            self.assertEqual(T.fm('TaiwanStockDividendResult','2330','2026-01-20','2026-02-05',''),[])
            expanded=T.fm('TaiwanStockDividendResult','2330','2026-01-01','2026-02-10','')
            self.assertEqual(expanded,events)
            self.assertEqual(calls,[('2026-01-20','2026-02-05'),('2026-01-01','2026-01-19'),('2026-02-06','2026-02-10')])
            T.fm('TaiwanStockDividendResult','2330','2026-01-01','2026-02-10','')
            self.assertEqual(len(calls),3)
    def test_failed_extension_not_confirmed_and_retry(self):
        with patch.object(T,'http_get_json',return_value={'status':200,'data':[]}):
            T.fm('TaiwanStockDividendResult','2330','2026-01-20','2026-02-05','')
        with patch.object(T,'http_get_json',return_value=None),C.operation():
            self.assertIsNone(T.fm('TaiwanStockDividendResult','2330','2026-01-01','2026-02-05',''))
        with patch.object(T,'http_get_json',return_value={'status':200,'data':[]}) as mock:
            self.assertEqual(T.fm('TaiwanStockDividendResult','2330','2026-01-01','2026-02-05',''),[])
            self.assertEqual(mock.call_args.args[1]['end_date'],'2026-01-19')
    def test_event_empty_history_refreshes_daily(self):
        with patch.object(T,'http_get_json',return_value={'status':200,'data':[]}):
            T.fm('TaiwanStockDividendResult','2330','2026-01-01','2026-01-31','')
        with C.database() as db:db.execute('UPDATE cache SET fetched=0')
        event={'date':'2026-01-10','stock_or_cache_dividend':'除息'}
        with patch.object(T,'http_get_json',return_value={'status':200,'data':[event]}):
            self.assertEqual(T.fm('TaiwanStockDividendResult','2330','2026-01-01','2026-01-31',''),[event])

    def mock_fetch(self,event_rows,info=None):
        raw=T.fetch_demo('2330',days=160,seed=5);calls=[]
        def fm(ds,code,*a,**kw):
            calls.append((ds,code))
            if ds=='TaiwanStockInfo':return info if info is not None else [{'stock_id':'2330','stock_name':'Test','type':'twse'}]
            if ds=='TaiwanStockDividendResult':return event_rows
            if ds=='TaiwanStockPrice':
                return [{'date':b['date'],'stock_id':code,'open':b['open'],'max':b['high'],'min':b['low'],
                         'close':b['close'] if code=='2330' else 100,'Trading_Volume':b['vol']*1000} for b in raw['bars']]
            return []
        with patch.object(T,'fm',side_effect=fm):
            data=T.fetch_finmind('2330',raw['bars'][0]['date'],raw['bars'][-1]['date'],'')
        return data,calls
    def test_price_basis_and_latest_market_record(self):
        data,calls=self.mock_fetch([], [{'stock_id':'2330','type':'twse','date':'2020-01-01'},
                                       {'stock_id':'2330','type':'tpex','date':'2026-01-01'}])
        self.assertIn(('TaiwanStockPrice','TPEx'),calls)
        self.assertFalse(any(ds=='TaiwanStockTotalReturnIndex' for ds,_ in calls))
        self.assertEqual(data['bench']['basis'],'price')
        payload=T.analyse('2330',data,30)
        self.assertEqual(payload['bench']['d20']['index'],0)
        self.assertEqual(payload['bench']['d20']['stock'],payload['bench']['d20']['rs'])
    def test_missing_market_not_assumed_listed(self):
        data,calls=self.mock_fetch([],[])
        self.assertIsNone(data['bench'])
        self.assertNotIn(('TaiwanStockPrice','TAIEX'),calls)
    def test_failed_event_fetch_is_unknown_not_no_events(self):
        data,_=self.mock_fetch(None)
        div=T.analyse('2330',data,30)['dividends']
        self.assertFalse(div['available']);self.assertEqual(div['status'],'unavailable')
        data,_=self.mock_fetch([])
        div=T.analyse('2330',data,30)['dividends']
        self.assertTrue(div['available']);self.assertEqual(div['recent'],[])
    def test_malformed_event_not_confirmed(self):
        data,_=self.mock_fetch([{'date':'2026-01-01','unexpected':1}])
        div=T.analyse('2330',data,30)['dividends']
        self.assertFalse(div['available']);self.assertEqual(div['status'],'partial')

if __name__=='__main__':unittest.main()
