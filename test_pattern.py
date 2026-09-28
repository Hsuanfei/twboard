# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""0928a：K 線型態、跳空缺口、頭肩型態與歷史統計；主K線圖的延伸區間與 10 年歷史。"""
import datetime as dt
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-pat-"))
import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twpattern as TP        # noqa: E402


def cols(bars):
    return ([b[0] for b in bars], [b[1] for b in bars], [b[2] for b in bars], [b[3] for b in bars])


def trend(n, start, step):
    """n 根連續 K：開＝前收、收＝前收＋step，上下影線各 0.3。"""
    out, c = [], start
    for _ in range(n):
        o, c = c, c + step
        out.append((o, max(o, c) + 0.3, min(o, c) - 0.3, c))
    return out


def found(bars, key):
    return TP.candles(*cols(bars))[key]


class CandleTests(unittest.TestCase):
    def test_engulfing_needs_trend_and_full_body(self):
        down = trend(8, 120, -1.0)                          # 收 119 → 112
        bars = down + [(112, 112.3, 110.7, 111), (110.8, 113.5, 110.5, 113.2)]
        self.assertIn(len(bars) - 1, found(bars, "bull_engulf"))
        # 同樣兩根放在上漲之後：不算多頭吞噬
        up = trend(8, 100, 1.0) + [(108, 108.3, 106.7, 107), (106.8, 109.5, 106.5, 109.2)]
        self.assertNotIn(len(up) - 1, found(up, "bull_engulf"))
        # 實體沒有完全包住（收盤沒超過前一根開盤）：不算
        weak = down + [(112, 112.3, 110.7, 111), (110.8, 112.4, 110.5, 111.9)]
        self.assertNotIn(len(weak) - 1, found(weak, "bull_engulf"))
        top = trend(8, 100, 1.0) + [(108, 109.3, 107.9, 109), (109.2, 109.4, 106.5, 107.5)]
        self.assertIn(len(top) - 1, found(top, "bear_engulf"))

    def test_doji_hammer_hanging_man_shooting_star(self):
        doji = trend(8, 100, 1.0) + [(108, 109, 107, 108.05)]
        self.assertIn(8, found(doji, "doji"))
        self.assertNotIn(8, found(doji, "hanging_man"), "十字線優先，不再判斷吊人線")
        shape = (100.0, 100.8, 97.0, 100.6)                     # 下影 3、實體 0.6、上影 0.2
        hammer = trend(8, 108, -1.0) + [shape]
        hanging = trend(8, 92, 1.0) + [shape]
        self.assertIn(8, found(hammer, "hammer"))
        self.assertIn(8, found(hanging, "hanging_man"))
        self.assertNotIn(8, found(hanging, "hammer"))
        star = trend(8, 92, 1.0) + [(100.0, 103.2, 99.8, 100.5)]
        self.assertIn(8, found(star, "shooting_star"))

    def test_morning_and_evening_star(self):
        base = trend(12, 130, -0.8)                          # 收 129.2 → 120.4
        long_black = (120.4, 120.6, 114.3, 114.5)
        small = (113.8, 114.0, 113.0, 113.6)
        rebound = (113.9, 118.9, 113.7, 118.6)               # 收過長黑實體一半（117.45）
        bars = base + [long_black, small, rebound]
        self.assertIn(len(bars) - 1, found(bars, "morning_star"))
        shallow = base + [long_black, small, (113.9, 116.3, 113.7, 116.0)]
        self.assertNotIn(len(shallow) - 1, found(shallow, "morning_star"), "沒收過一半不算")
        top = trend(12, 90, 0.8) + [(99.6, 105.9, 99.4, 105.7), (106.3, 107.2, 106.1, 106.6), (106.2, 106.4, 101.3, 101.6)]
        self.assertIn(len(top) - 1, found(top, "evening_star"))

    def test_three_soldiers_and_crows_counted_once(self):
        flat = [(100, 100.4, 99.6, 100.1)] * 10
        soldiers = [(100.1, 102.2, 100.0, 102.0), (101.2, 104.1, 101.1, 104.0), (103.1, 106.1, 103.0, 106.0),
                    (105.2, 108.1, 105.1, 108.0)]
        bars = flat + soldiers
        self.assertEqual(found(bars, "three_white"), [12], "四連紅只記第一次")
        crows = flat + [(100.1, 100.2, 98.0, 98.1), (99.0, 99.1, 96.0, 96.1), (97.0, 97.1, 94.0, 94.1)]
        self.assertEqual(found(crows, "three_black"), [12])


class GapTests(unittest.TestCase):
    def test_gap_up_filled_and_gap_down_open(self):
        h = [101, 101, 105, 104, 103, 100.5, 100, 99, 96, 95]
        l = [99, 99.5, 102, 102.5, 101, 99.8, 99, 97.5, 94, 93]
        c = [100, 100.5, 104, 103, 102, 100, 99.5, 98, 95, 94]
        got = TP.gaps(h, l, c)
        up = [g for g in got if g["dir"] == "up"][0]
        self.assertEqual((up["i"], up["lo"], up["hi"], up["fill"]), (2, 101, 102, 4), "第 4 根最低 101 碰到缺口下緣就算回補")
        down = [g for g in got if g["dir"] == "down"][0]
        self.assertEqual((down["i"], down["lo"], down["hi"], down["fill"]), (8, 96, 97.5, None))
        # 太小的缺口（< 0.5%）不算
        self.assertEqual(TP.gaps([100, 100.4], [99, 100.2], [100, 100.3]), [])


def hs_path(anchors, extra=()):
    """依錨點線性內插的收盤價，開＝前收、影線 0.5；用來組出清楚的頭肩型態。"""
    closes = []
    for (i0, p0), (i1, p1) in zip(anchors, anchors[1:]):
        for i in range(i0, i1):
            closes.append(p0 + (p1 - p0) * (i - i0) / (i1 - i0))
    closes.append(anchors[-1][1])
    o = [closes[0]] + closes[:-1]
    h = [max(a, b) + 0.5 for a, b in zip(o, closes)]
    l = [min(a, b) - 0.5 for a, b in zip(o, closes)]
    return o, h, l, closes


class HeadShouldersTests(unittest.TestCase):
    TOP = [(0, 90), (20, 110), (30, 100), (40, 120), (50, 101), (60, 111), (80, 92)]

    def test_confirmed_top(self):
        o, h, l, c = hs_path(self.TOP)
        got = TP.head_shoulders(h, l, c)
        self.assertEqual(len(got), 1)
        x = got[0]
        self.assertEqual(x["key"], "hs_top"); self.assertTrue(x["confirmed"])
        self.assertEqual([p[0] for p in x["points"]], [20, 30, 40, 50, 60])
        i1, y1, i2, y2 = x["neck"]
        self.assertEqual(i2, x["break"])
        self.assertLess(c[x["break"]], y2, "確認那天收盤在頸線之下")
        self.assertGreaterEqual(c[x["break"] - 1], y1 + (y2 - y1) * (x["break"] - 1 - i1) / (i2 - i1) - 1e-9)

    def test_pending_and_invalidated(self):
        o, h, l, c = hs_path(self.TOP[:-1] + [(68, 106)])     # 右肩成形、還沒跌破頸線
        got = TP.head_shoulders(h, l, c)
        self.assertEqual(len(got), 1); self.assertFalse(got[0]["confirmed"]); self.assertIsNone(got[0]["break"])
        o, h, l, c = hs_path(self.TOP[:-1] + [(66, 104), (80, 128)])   # 往上突破頭部：不再是頭肩頂
        self.assertEqual([x for x in TP.head_shoulders(h, l, c) if x["key"] == "hs_top"], [])

    def test_bottom_is_mirror(self):
        anchors = [(i, 200 - p) for i, p in self.TOP]
        o, h, l, c = hs_path(anchors)
        got = TP.head_shoulders(h, l, c)
        self.assertEqual([(x["key"], x["confirmed"]) for x in got], [("hs_bottom", True)])

    def test_shoulders_must_be_balanced(self):
        lopsided = [(0, 90), (20, 104), (30, 100), (40, 120), (50, 101), (60, 118), (80, 92)]
        o, h, l, c = hs_path(lopsided)
        self.assertEqual(TP.head_shoulders(h, l, c), [])


class StatsTests(unittest.TestCase):
    def test_forward_returns_and_baseline(self):
        c = [100, 100, 100, 100, 100, 110, 90, 100, 100, 100, 100, 121]
        st = TP._stats([0, 1, 6], c, len(c))
        self.assertEqual((st["total"], st["n5"], st["up5"], st["avg5"]), (3, 3, 66.7, 11.48))   # +10、−10、+34.44
        self.assertEqual((st["n10"], st["up10"]), (2, 50.0), "第 6 根還沒有 10 日後的資料；持平不算上漲")
        self.assertEqual(TP._stats([], c, len(c))["up5"], None)

    def test_analyse_window_indexes_and_span(self):
        raw = T.fetch_demo("PAT", days=160, seed=3, history_days=2500)
        h = raw["history"]
        d = [b["date"] for b in h]
        res = TP.analyse(d, *[[b[k] for b in h] for k in ("open", "high", "low", "close")], window=120)
        self.assertEqual(len(res["defs"]), 14)
        self.assertEqual(res["span"]["label"], "近 10 年")
        self.assertTrue(res["events"] and all(0 <= e["i"] < 120 for e in res["events"]))
        self.assertTrue(all(e["f5"] is None for e in res["events"] if e["i"] >= 115), "最後 5 天還沒有 5 日後報酬")
        total = sum(v["total"] for k, v in res["stats"].items() if not k.startswith(("gap_", "hs_")))
        self.assertGreater(total, len(res["events"]), "統計用完整歷史，不只畫面上的區間")
        self.assertEqual(res["baseline"]["total"], 2500)
        self.assertIsNone(TP.analyse(d[:5], [1] * 5, [1] * 5, [1] * 5, [1] * 5))


class KlinePayloadTests(unittest.TestCase):
    def test_extended_ranges_indicators_and_fib(self):
        raw = T.fetch_demo("KLN", days=160, seed=5, history_days=2500)
        p = T.analyse("KLN", raw, 30)
        k = p["kline"]
        self.assertEqual(k["ranges"], [30, 60, 120, 250])
        self.assertEqual(len(k["date"]), 250); self.assertEqual(k["date"][-1], p["last_date"])
        self.assertEqual(k["close"][-1], p["quote"]["close"])
        self.assertIsNotNone(k["ma60"][0], "均線在完整歷史上計算，250 日區間的第一天也有 MA60")
        self.assertEqual(k["fib"]["30"], p["fibonacci"], "分析天數的區間與原本的費波南希相同")
        self.assertEqual(k["fib"]["250"]["window_days"], 250)
        self.assertEqual(p["patterns"]["span"]["bars"], 2500)
        self.assertEqual(p["bars_count"], 30, "18 格仍然只顯示分析天數")
        short = T.analyse("S", T.fetch_demo("S", days=80, seed=7), 30)
        self.assertEqual(short["kline"]["ranges"], [30, 60, 80], "歷史不足 120 天時提供「全部 80 日」")

    def test_history_merge_prefers_analysis_bars(self):
        bars = [{"date": "2026-09-0%d" % i, "open": 1, "high": 1, "low": 1, "close": 10.0 + i, "vol": 1} for i in range(3, 6)]
        hist = [{"date": "2026-09-0%d" % i, "open": 1, "high": 1, "low": 1, "close": 1.0, "vol": 1} for i in range(1, 7)]
        got = T.merged_history({"history": hist}, bars)
        self.assertEqual([b["date"] for b in got], ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
                         "不超過分析資料的最後一天")
        self.assertEqual([b["close"] for b in got][2:], [13.0, 14.0, 15.0])


class HistoryFetchTests(unittest.TestCase):
    def setUp(self):
        C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-pat-"))
        self.calls = []

    def fake(self, fail_old=False):
        def http(url, params=None, **kw):
            ds, did = params["dataset"], params["data_id"]
            self.calls.append((ds, did, params["start_date"], params["end_date"]))
            if ds == "TaiwanStockInfo":
                return {"status": 200, "data": [{"stock_id": did, "stock_name": "測試", "type": "twse"}]}
            if ds == "TaiwanStockDividendResult":
                return {"status": 200, "data": []}
            d0, d1 = dt.date.fromisoformat(params["start_date"]), dt.date.fromisoformat(params["end_date"])
            if fail_old and ds == "TaiwanStockPrice" and (C.today() - d0).days > 800:
                return None
            rows, d = [], d0
            while d <= d1:
                if d.weekday() < 5:
                    day = d.isoformat()
                    if ds == "TaiwanStockPrice":
                        px = 100 + d.toordinal() % 17
                        rows.append({"date": day, "stock_id": did, "open": px, "max": px + 1, "min": px - 1, "close": px,
                                     "Trading_Volume": 1000000, "Trading_money": 1e8, "Trading_turnover": 10})
                    elif ds == "TaiwanStockInstitutionalInvestorsBuySell":
                        rows.append({"date": day, "name": "Foreign_Investor", "buy": 2000, "sell": 1000})
                    else:
                        rows.append({"date": day, "MarginPurchaseTodayBalance": 1, "MarginPurchaseYesterdayBalance": 1,
                                     "ShortSaleTodayBalance": 1, "ShortSaleYesterdayBalance": 1})
                d += dt.timedelta(days=1)
            return {"status": 200, "data": rows}
        return http

    def test_ten_years_once_then_incremental(self):
        with patch.object(T, "http_get_json", side_effect=self.fake()), C.operation():
            raw = T.fetch_raw("2330", 30, "finmind")
        hist = raw["history"]
        self.assertGreater(len(hist), 2400)
        self.assertLessEqual((C.today() - dt.date.fromisoformat(hist[0]["date"])).days, int(10 * 365.25) + 3)
        price = [x for x in self.calls if x[0] == "TaiwanStockPrice" and x[1] == "2330"]
        self.assertEqual(len(price), 2, "分析區間一次、更早的 10 年一次：%s" % price)
        self.calls.clear()
        with patch.object(T, "http_get_json", side_effect=self.fake()), C.operation():
            T.fetch_raw("2330", 30, "finmind")
        self.assertEqual([x for x in self.calls if x[0] == "TaiwanStockPrice" and x[1] == "2330"], [], "第二次全部走快取")
        p = T.analyse("2330", raw, 30)
        self.assertEqual(p["patterns"]["span"]["label"], "近 10 年")

    def test_history_failure_does_not_break_analysis(self):
        with patch.object(T, "http_get_json", side_effect=self.fake(fail_old=True)), C.operation() as st:
            raw = T.fetch_raw("2330", 30, "finmind")
        self.assertTrue(raw and raw["bars"])
        self.assertTrue(any(w.startswith("歷史股價") for w in st["warnings"]), st["warnings"])
        p = T.analyse("2330", raw, 30)
        self.assertLess(p["patterns"]["span"]["bars"], 400, "拿不到 10 年歷史時，用已取得的期間統計")


if __name__ == "__main__":
    unittest.main()
