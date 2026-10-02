# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""0928a：族群輪動的每日軌跡（熱力矩陣、排名變化、象限時間軸、動能加速度用）與自訂族群的「代號 名稱」格式。"""
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-sr-"))
os.environ["TWBOARD_DATA_DIR"] = tempfile.mkdtemp(prefix="twboard-sr-data-")
import twcache as C           # noqa: E402
import twmarket as MK         # noqa: E402
import twserve as S           # noqa: E402

MK.INTERVAL = {}


class HistoryTests(unittest.TestCase):
    def test_back_pct_skips_missing_days(self):
        closes = [100.0, 101.0, None, 102.0, 103.0, 104.0, 110.0]
        self.assertAlmostEqual(MK._back_pct(closes, 6, 5), (110 / 101 - 1) * 100, places=6)
        self.assertAlmostEqual(MK._back_pct(closes, 6, 4), (110 / 101 - 1) * 100, places=6, msg="4 天前停牌，往前找")
        self.assertIsNone(MK._back_pct(closes, 2, 1), "那天沒成交")
        self.assertIsNone(MK._back_pct(closes, 1, 5), "資料不夠長")

    def test_history_series_equal_weight(self):
        n = 30
        closes = {"A": [100.0 + i for i in range(n)], "B": [100.0] * n, "Z": [None] * n}
        h = MK.history_series(["A", "B", "Z", "MISSING"], closes, n, days=20)
        self.assertEqual([len(h[k]) for k in ("day", "r5", "r20")], [20, 20, 20])
        a5 = (129 / 124 - 1) * 100
        self.assertAlmostEqual(h["r5"][-1], round(a5 / 2, 2), places=2, msg="A 與 B 的等權平均；沒成交的不算")
        self.assertAlmostEqual(h["r20"][-1], round((129 / 109 - 1) * 100 / 2, 2), places=2)
        self.assertIsNone(MK.history_series(["A"], closes, 10, days=20)["r20"][0], "前 20 天算不出 20 日報酬")

    def test_scan_payload_has_history_and_last_point_matches_table(self):
        raw = MK.demo_raw(61)
        res = MK.analyse(raw, MK.DEFAULT_THEMES)
        self.assertEqual(len(res["sector_dates"]), 20); self.assertEqual(res["sector_dates"][-1], res["latest_date"])
        self.assertEqual(len(res["market_hist"]["day"]), 20)
        for g in res["sectors"]:
            h = g["hist"]
            self.assertEqual([len(h[k]) for k in ("day", "r5", "r20")], [20, 20, 20], g["name"])
            self.assertAlmostEqual(h["r5"][-1], g["r5"], delta=0.02, msg=g["name"])
            self.assertAlmostEqual(h["r20"][-1], g["r20"], delta=0.02, msg=g["name"])
            self.assertGreater(g["amount"], 0)
        quads = set()
        for g in res["sectors"]:
            quads |= {MK.quadrant(a, b) for a, b in zip(g["hist"]["r5"], g["hist"]["r20"])}
        self.assertTrue({"領漲", "轉強", "轉弱", "落後"} <= quads, "示範資料會輪動經過四個象限")
        short = MK.analyse(MK.demo_raw(21), MK.DEFAULT_THEMES)
        g = short["sectors"][0]
        self.assertEqual(sum(v is not None for v in g["hist"]["r20"]), 1, "20 日期間只有最後一天有 20 日報酬")


class ThemeFormatTests(unittest.TestCase):
    def test_code_name_items(self):
        got = MK.normalize_themes([{"name": "IP", "codes": "3661 世芯-KY, 3443 創意，6643 M31、5274 信驊"}])
        self.assertEqual(got[0]["codes"], ["3661", "3443", "6643", "5274"], "名稱裡有數字（M31）也不會被當成代號")
        got = MK.normalize_themes([{"name": "AI", "codes": "2330 2317\n2454"}])
        self.assertEqual(got[0]["codes"], ["2330", "2317", "2454"], "空白分隔的純代號照舊")
        with self.assertRaises(ValueError) as e:
            MK.normalize_themes([{"name": "A", "codes": "台積電 2330, 2317"}])
        self.assertIn("代號要寫在名稱前面", str(e.exception))
        for t in MK.DEFAULT_THEMES:
            MK.normalize_themes([t])
        self.assertLessEqual(len(MK.DEFAULT_THEMES), MK.MAX_THEMES)


class ThemeNamesApiTests(unittest.TestCase):
    def setUp(self):
        C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-sr-"))
        os.environ["TWBOARD_DATA_DIR"] = tempfile.mkdtemp(prefix="twboard-sr-data-")
        S.DEMO_MODE = True
        S._market.update(raw=None, results={}, job=None, by={})
        self.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); S.DEMO_MODE = False

    def call(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "Origin": self.base})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def test_names_after_scan(self):
        self.assertEqual(self.call("/api/themes")["names"], {}, "還沒掃描時沒有名稱可以帶入")
        job = self.call("/api/market/scan", {"days": "60"})["job_id"]
        for _ in range(200):
            j = self.call("/api/jobs/" + job)["job"]
            if j["status"] in ("done", "error"):
                break
            time.sleep(0.05)
        self.assertEqual(j["status"], "done")
        r = self.call("/api/themes")
        code = r["themes"][0]["codes"][0]
        self.assertEqual(r["names"][code], "示範" + code)
        saved = self.call("/api/themes", {"themes": json.dumps([{"name": "新族群", "codes": code + " 隨便寫的名稱, 2330, 2317"}])})
        self.assertEqual(saved["themes"][0]["codes"], [code, "2330", "2317"])
        self.assertIn(code, saved["names"])


if __name__ == "__main__":
    unittest.main()
