# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
import contextlib
import copy
import csv
import io
import json
import threading
import tempfile
from pathlib import Path
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch
import twboard as T
import twserve as S


class DataIntegrityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        cache_patch = patch.object(T.TC,"CACHE_DIR",Path(temp.name))
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        self.addCleanup(T.TC.close_cache)
        self.raw = T.fetch_demo("DEMO", days=80, seed=7)
        self.dates = [b["date"] for b in self.raw["bars"]]
        self.raw["chips"] = {d: {"foreign": 100., "trust": -20., "dealer": 10.} for d in self.dates}

    def test_complete_windows(self):
        d = T.analyse("DEMO", self.raw, 10)
        self.assertEqual((d["chip"]["net5"], d["chip"]["net20"]), (450, 1800))
        self.assertIsNotNone(d["scores"]["chip"])

    def test_stale_chips_do_not_fill_recent_windows(self):
        self.raw["chips"] = {self.dates[-10]: {"foreign": 100., "trust": 0., "dealer": 0.}}
        d = T.analyse("DEMO", self.raw, 30)
        self.assertIsNone(d["chip"]["net5"])
        self.assertIsNone(d["scores"]["chip"])
        self.assertEqual(d["chip"]["coverage5"], 0)
        self.assertTrue(d["chip"]["stale"])
        self.assertEqual([r["date"] for r in d["chip"]["recent"]], list(reversed(self.dates[-5:])))

    def test_gap_within_twenty_days_disables_chip_score(self):
        del self.raw["chips"][self.dates[-12]]
        d = T.analyse("DEMO", self.raw, 30)
        self.assertEqual(d["chip"]["net5"], 450)
        self.assertIsNone(d["chip"]["net20"])
        self.assertIsNone(d["scores"]["chip"])
        self.assertEqual(d["chip"]["coverage20"], 19)

    def test_missing_category_is_not_zero(self):
        self.raw["chips"][self.dates[-1]]["trust"] = None
        d = T.analyse("DEMO", self.raw, 30)
        self.assertIsNone(d["series"]["chip_total"][-1])
        self.assertIsNone(d["chip"]["net5"])

    def test_actual_zero_is_valid(self):
        self.raw["chips"] = {d: {"foreign": 0., "trust": 0., "dealer": 0.} for d in self.dates}
        d = T.analyse("DEMO", self.raw, 30)
        self.assertEqual(d["chip"]["net20"], 0)
        self.assertEqual(d["scores"]["chip"], 50)

    def test_requested_coverage_and_indicator_readiness(self):
        d = T.analyse("DEMO", self.raw, 500)
        self.assertEqual((d["avail"]["price_days"], d["avail"]["need_days"]), (80, 500))
        self.raw["bars"] = self.raw["bars"][-30:]
        self.assertFalse(T.analyse("DEMO", self.raw, 30)["avail"]["indicators_ready"])

    def test_stale_and_missing_margin(self):
        self.raw["margin"] = {self.dates[-3]: {"margin_bal": 100., "margin_prev": None, "short_bal": 0., "short_prev": 0.}}
        d = T.analyse("DEMO", self.raw, 30)
        self.assertFalse(d["avail"]["margin_current"])
        self.assertIsNone(d["margin"]["margin_chg"])
        self.assertEqual(d["margin"]["short_chg"], 0)

    def test_finmind_units_and_missing_category(self):
        def fake(dataset, *args, **kwargs):
            if dataset == "TaiwanStockPrice":
                return [{"date": "2020-04-06", "close": 275, "Trading_Volume": 1000000}]
            if dataset == "TaiwanStockMarginPurchaseShortSale":
                return [{"date": "2020-04-06", "MarginPurchaseTodayBalance": 26285, "MarginPurchaseYesterdayBalance": 25648, "ShortSaleTodayBalance": 0}]
            if dataset == "TaiwanStockInstitutionalInvestorsBuySell":
                return [{"date": "2020-04-06", "name": "Foreign_Investor", "buy": 2000, "sell": 1000}]
            return []
        with patch.object(T, "fm", side_effect=fake):
            raw = T.fetch_finmind("2330", "2020-04-06", "2020-04-06", "")
        self.assertEqual(raw["margin"]["2020-04-06"]["margin_bal"], 26285)
        self.assertIsNone(raw["margin"]["2020-04-06"]["short_prev"])
        self.assertEqual(raw["bars"][0]["vol"], 1000)
        self.assertEqual(raw["chips"]["2020-04-06"]["foreign"], 1)
        self.assertIsNone(raw["chips"]["2020-04-06"]["trust"])

    def test_finmind_token_only_in_header(self):
        with patch.object(T, "http_get_json", return_value={"status": 200, "data": []}) as get:
            T.fm("TaiwanStockPrice", "2330", "2020-04-06", "2020-04-06", "test-secret")
        self.assertNotIn("token", get.call_args.args[1])
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer test-secret")

    def test_export_escapes_script_end_and_title(self):
        d = T.analyse("DEMO", self.raw, 30)
        d["name"] = "</script><script>alert(1)</script>"
        output = T.render(d, "")
        self.assertNotIn(d["name"], output)
        self.assertIn("&lt;/script&gt;", output)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        S.DEMO_MODE = True
        cls.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        S.DEMO_MODE = False
        S.SESSION_TOKEN = None
        S._cache.clear()
        S._snapshots.clear()

    def request(self, path, obj=None, headers=None):
        data = json.dumps(obj).encode() if obj is not None else None
        h = {"Content-Type": "application/json"} if data else {}
        h.update(headers or {})
        request = urllib.request.Request(self.base + path, data=data, headers=h)
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_snapshot_export_does_not_fetch_or_reanalyse(self):
        status, body = self.request("/api/analyse", {"code": "DEMO", "days": 30})
        self.assertEqual(status, 200)
        d = json.loads(body)["data"]
        S._cache.clear()
        with patch.object(S, "get_payload", side_effect=AssertionError("must not refetch")):
            status, csv_body = self.request("/api/csv?snapshot=" + d["snapshot_id"] + "&days=60")
            self.assertEqual(status, 200)
            rows = list(csv.DictReader(io.StringIO(csv_body.decode("utf-8-sig"))))
            self.assertEqual(len(rows), 30)
            self.assertEqual(float(rows[-1]["收盤"]), d["series"]["close"][-1])
            self.assertEqual(rows[-1]["產生時間"], d["generated"])
            status, html = self.request("/api/export?snapshot=" + d["snapshot_id"])
            self.assertEqual(status, 200)
            self.assertIn(d["snapshot_id"].encode(), html)

    def test_missing_snapshot_does_not_refetch(self):
        with patch.object(S, "get_payload", side_effect=AssertionError("must not refetch")):
            status, body = self.request("/api/csv?snapshot=missing")
        self.assertEqual(status, 400)
        self.assertIn("快照已失效", json.loads(body)["error"])

    def test_token_memory_reset_and_log_redaction(self):
        capture = io.StringIO()
        with contextlib.redirect_stderr(capture):
            self.assertEqual(self.request("/api/token", {"token": "test-secret"})[0], 200)
            self.assertEqual(S.SESSION_TOKEN, "test-secret")
            self.assertEqual(self.request("/api/analyse?token=test-secret&code=DEMO")[0], 400)
            self.assertEqual(self.request("/api/token", {"token": ""})[0], 200)
        self.assertEqual(S.SESSION_TOKEN, "")
        self.assertNotIn("test-secret", capture.getvalue())

    def test_cross_origin_and_get_analysis_rejected(self):
        self.assertEqual(self.request("/api/token", {"token": "bad"}, {"Origin": "https://other.example"})[0], 403)
        self.assertEqual(self.request("/api/analyse?code=DEMO")[0], 405)
        self.assertEqual(self.request("/api/health", headers={"Host": "other.example"})[0], 403)

    def test_snapshot_capacity_is_bounded(self):
        with patch.object(S, "MAX_SNAPSHOTS", 2):
            S._snapshots.clear()
            first = S.save_snapshot({})["snapshot_id"]
            second = S.save_snapshot({})["snapshot_id"]
            S.save_snapshot({})
            self.assertEqual(len(S._snapshots), 2)
            self.assertNotIn(first, S._snapshots)
            self.assertIn(second, S._snapshots)


if __name__ == "__main__":
    unittest.main()
