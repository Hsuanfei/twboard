# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""費波南希回撤的計算測試。"""
import os
import tempfile
import unittest
from pathlib import Path

_tmp = tempfile.TemporaryDirectory()
os.environ.setdefault("TWBOARD_CACHE_DIR", str(Path(_tmp.name) / "cache"))

import twboard as T           # noqa: E402


def series(points):
    """points: [(high, low, close), ...] → (date, high, low, close)"""
    date = ["2026-01-%02d" % (i + 1) for i in range(len(points))]
    return date, [p[0] for p in points], [p[1] for p in points], [p[2] for p in points]


class FibonacciTests(unittest.TestCase):
    def test_up_swing_levels_measure_down_from_the_high(self):
        d, h, l, c = series([(110, 100, 105), (130, 108, 128), (160, 125, 158), (200, 150, 195), (190, 170, 176.4)])
        f = T.fibonacci(d, h, l, c)
        self.assertTrue(f["available"]); self.assertEqual(f["direction"], "up")
        self.assertEqual((f["low"], f["high"]), ({"price": 100.0, "date": d[0]}, {"price": 200.0, "date": d[3]}))
        self.assertEqual([lv["price"] for lv in f["levels"]], [200.0, 176.4, 161.8, 150.0, 138.2, 121.4, 100.0])
        self.assertEqual([lv["label"] for lv in f["levels"]], ["0%", "23.6%", "38.2%", "50%", "61.8%", "78.6%", "100%"])
        self.assertEqual(f["retraced_pct"], 23.6)
        self.assertEqual(f["at"]["label"], "23.6%")            # 收盤正好在線上
        self.assertEqual(f["above"]["label"], "0%"); self.assertEqual(f["below"]["label"], "38.2%")
        self.assertFalse(f["extending"]); self.assertEqual(f["bars_since_swing_end"], 1)

    def test_down_swing_levels_measure_up_from_the_low(self):
        d, h, l, c = series([(200, 190, 195), (198, 170, 172), (175, 140, 142), (150, 100, 104), (135, 110, 130)])
        f = T.fibonacci(d, h, l, c)
        self.assertEqual(f["direction"], "down")
        self.assertEqual([lv["price"] for lv in f["levels"]], [100.0, 123.6, 138.2, 150.0, 161.8, 178.6, 200.0])
        self.assertEqual(f["retraced_pct"], 30.0)               # 從低點 100 反彈到 130
        self.assertEqual((f["below"]["label"], f["above"]["label"]), ("23.6%", "38.2%"))
        self.assertAlmostEqual(f["above"]["distance_pct"], round((138.2 - 130) / 130 * 100, 2))
        self.assertLess(f["below"]["distance_pct"], 0)

    def test_still_extending_means_nothing_retraced_yet(self):
        d, h, l, c = series([(101, 100, 100.5), (105, 101, 104), (110, 104, 109), (118, 108, 117), (125, 116, 125)])
        f = T.fibonacci(d, h, l, c)
        self.assertTrue(f["extending"]); self.assertEqual(f["retraced_pct"], 0.0)
        self.assertIsNone(f["above"]); self.assertEqual(f["at"]["label"], "0%")

    def test_ties_use_the_most_recent_extreme(self):
        d, h, l, c = series([(200, 150, 160), (180, 100, 120), (200, 140, 150), (170, 100, 130), (160, 120, 140)])
        f = T.fibonacci(d, h, l, c)
        self.assertEqual((f["high"]["date"], f["low"]["date"]), (d[2], d[3]))
        self.assertEqual(f["direction"], "down")

    def test_window_start_limits_the_swing(self):
        d, h, l, c = series([(500, 300, 300)] + [(110 + i, 100 + i, 105 + i) for i in range(8)])
        self.assertEqual(T.fibonacci(d, h, l, c)["high"]["price"], 500.0)
        f = T.fibonacci(d, h, l, c, start=1)
        self.assertEqual((f["high"]["price"], f["low"]["price"], f["window_days"], f["from"]), (117.0, 100.0, 8, d[1]))

    def test_unusable_windows_say_why_instead_of_guessing(self):
        d, h, l, c = series([(10, 10, 10)] * 6)
        self.assertEqual(T.fibonacci(d, h, l, c), {"available": False, "reason": "區間內沒有價差"})
        d, h, l, c = series([(10, 9, 9.5)] * 3)
        self.assertFalse(T.fibonacci(d, h, l, c)["available"])
        d, h, l, c = series([(10, 9.5, 9.8), (30, 1, 20), (10, 9.5, 9.8), (10, 9.5, 9.8), (10, 9.5, 9.8)])
        self.assertIn("同一個交易日", T.fibonacci(d, h, l, c)["reason"])

    def test_payload_uses_the_display_window_and_no_future_bars(self):
        raw = T.fetch_demo("FIB", days=200, seed=5)
        a30, a120 = T.analyse("FIB", raw, 30)["fibonacci"], T.analyse("FIB", raw, 120)["fibonacci"]
        self.assertEqual((a30["window_days"], a120["window_days"]), (30, 120))
        bars = raw["bars"][-30:]
        self.assertEqual(a30["high"]["price"], max(b["high"] for b in bars))
        self.assertEqual(a30["low"]["price"], min(b["low"] for b in bars))
        self.assertGreaterEqual(a120["high"]["price"], a30["high"]["price"])
        earlier = T.analyse("FIB", dict(raw, bars=raw["bars"][:-10]), 30)["fibonacci"]
        self.assertEqual(earlier["to"], raw["bars"][-11]["date"])
        self.assertLessEqual(earlier["high"]["date"], earlier["to"])

    def test_export_contains_levels_and_explanation(self):
        html = T.render(T.analyse("FIB", T.fetch_demo("FIB", days=200, seed=5), 30), "")
        self.assertIn('"fibonacci"', html); self.assertIn('id="btn-fib"', html); self.assertIn("沒有可靠的證據", html)


if __name__ == "__main__":
    unittest.main()
