# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import twpower as P
import twpattern as TP
import twcache as C
import twserve as S
from test_power import make_bars, trading_days
from test_pattern import hs_path


class Regression1002a(unittest.TestCase):
    def test_split_day_real_return_and_unknown_jump(self):
        bars = make_bars([100,100,27.5,27.5])
        adj, ds, sp = P.adjust_for_splits(bars, [], [{"date":bars[2]["date"],"before":100,"reference":25}])
        self.assertEqual(sp[0]["ratio"],4)
        self.assertAlmostEqual(dict(P.daily_returns(adj, ds))[bars[2]["date"]],0.1)
        unchanged, _, sp = P.adjust_for_splits(bars, [])
        self.assertEqual(unchanged,bars)
        self.assertEqual(sp,[])
        self.assertEqual(P.price_jumps(unchanged,[]),[bars[2]["date"]])

    def test_live_split_reference_field_mapping(self):
        live=P.Live("0050")
        def fake(dataset,*args,**kwargs):
            if dataset=="TaiwanStockSplitPrice":
                return [{"date":"2025-06-18","stock_id":"0050","before_price":188.65,"after_price":47.16},
                        {"date":"2025-06-18","stock_id":"9999","before_price":100,"after_price":25}]
            return [{"date":"2025-01-02","stock_id":"0050","before_close":100,"after_ref_close":50}]
        with patch.object(live,"_fm",side_effect=fake):
            rows=live.actions()
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]["reference"],47.16)
        self.assertEqual(rows[1]["reference"],50)

    def test_reverse_split_keeps_daily_decline(self):
        bars=make_bars([10,10,45,44])
        adj,ds,sp=P.adjust_for_splits(bars,[],[{"date":bars[2]["date"],"before":10,"reference":50}])
        self.assertAlmostEqual(dict(P.daily_returns(adj,ds))[bars[2]["date"]],-0.1)
        self.assertEqual(adj[0]["vol"],200)

    def test_reference_price_precedes_after_price(self):
        bars=make_bars([100,104.5])
        self.assertAlmostEqual(P.daily_returns(bars,[{"date":bars[1]["date"],"before":100,"after":104.5,"reference":95}])[0][1],0.1)

    def test_missing_dividend_history_and_missing_event_date(self):
        bars=make_bars([95,100,101])
        result=P.dividend_fill(bars,[{"date":"2020-01-01","before":100,"amount":5}])
        self.assertFalse(result["available"])
        self.assertEqual(len(result["excluded"]),1)
        full=make_bars([100,95,96,97,101])
        missing=full[:2]+full[3:]
        result=P.dividend_fill(missing,[{"date":full[1]["date"],"before":100,"amount":5}], [b["date"] for b in full])
        self.assertFalse(result["available"])

    def test_recent_success_does_not_bias_fill_probability(self):
        bars=make_bars([100,101,102])
        r=P.dividend_fill(bars,[{"date":bars[1]["date"],"before":100,"amount":5}])
        self.assertEqual(r["same_day"],100)
        self.assertIsNone(r["within20"])
        self.assertEqual(r["n20"],0)

    def test_stale_and_gapped_months(self):
        bars=make_bars([100]*500,start="2024-01-02")
        bars=[b for b in bars if b["date"]<="2025-02-06"]
        r=P.seasonality(bars,[],today=dt.date(2025,3,2))
        feb=r["table"][0]["months"][1]
        self.assertTrue(feb["partial"])
        calendar=trading_days("2024-01-02",500)
        calendar=[d for d in calendar if d<="2025-03-03"]
        r=P.seasonality(bars,[],today=dt.date(2025,3,4),trading_dates=calendar)
        self.assertTrue(r["table"][0]["months"][1]["partial"])
        missing=[b for b in bars if b["date"]!="2025-01-15"]
        r=P.seasonality(missing,[],today=dt.date(2025,3,4),trading_dates=calendar)
        self.assertTrue(r["table"][0]["months"][0]["partial"])

    def test_head_shoulders_are_available_when_signalled(self):
        o,h,l,c=hs_path([(0,90),(20,110),(30,100),(40,120),(50,101),(60,111),(63,98),(80,92)])
        found=TP.head_shoulders(h,l,c)
        confirmed=[x for x in found if x["confirmed"]]
        self.assertTrue(confirmed)
        for x in confirmed:
            self.assertGreaterEqual(x["break"],x["points"][-1][0]+TP.PIVOT_K)
            prefix=TP.head_shoulders(h[:x["break"]+1],l[:x["break"]+1],c[:x["break"]+1])
            self.assertIn(x,prefix)
        previous=set()
        for t in range(12,len(c)+1):
            now={(x["key"],x["break"]) for x in TP.head_shoulders(h[:t],l[:t],c[:t]) if x["confirmed"]}
            self.assertTrue(previous.issubset(now))
            previous=now

    def test_cache_connection_released_on_directory_change_and_close(self):
        with tempfile.TemporaryDirectory() as a,tempfile.TemporaryDirectory() as b,patch.object(C,"CACHE_DIR",Path(a)):
            C.write("key",{"2026-01-01":[]})
            with patch.object(C,"CACHE_DIR",Path(b)):
                C.write("key",{"2026-01-01":[]})
                (Path(a)/"market.sqlite3").unlink()
                C.close_cache()
                (Path(b)/"market.sqlite3").unlink()

    def test_server_returns_only_remaining_cache_lifetime(self):
        S._power_cache.clear()
        with patch.object(S.P,"build",return_value={"available":True}),patch.object(C,"today",return_value=dt.date(2026,10,2)):
            with patch.object(S.time,"time",return_value=1000):
                S.get_power({"code":["2330"]})
            with patch.object(S.time,"time",return_value=1300):
                r=S.get_power({"code":["2330"]})
                self.assertEqual(r["cache_ttl_seconds"],300)
                self.assertEqual(S.P.build.call_count,1)
        S._power_cache.clear()

    def test_server_cache_crosses_taipei_date(self):
        S._power_cache.clear()
        with patch.object(S.P,"build",return_value={"available":True}),patch.object(C,"today",return_value=dt.date(2026,10,2)):
            S.get_power({"code":["2330"]})
            S.get_power({"code":["2330"]})
            self.assertEqual(S.P.build.call_count,1)
            with patch.object(C,"today",return_value=dt.date(2026,10,3)):
                S.get_power({"code":["2330"]})
            self.assertEqual(S.P.build.call_count,2)
        S._power_cache.clear()

if __name__ == '__main__': unittest.main()
