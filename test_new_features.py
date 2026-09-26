# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""0920c 新功能的測試：快取鍵與精簡化、清理、逐日規則分與回測、相對強弱、除權息、群組、批次、連線失敗處理。"""
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

_tmp = tempfile.TemporaryDirectory()
os.environ["TWBOARD_CACHE_DIR"] = str(Path(_tmp.name) / "cache")
os.environ["TWBOARD_WATCHLIST_FILE"] = str(Path(_tmp.name) / "watchlists.json")

import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twserve as S           # noqa: E402
import twbatch as B           # noqa: E402


def fresh_cache():
    folder = tempfile.mkdtemp(dir=_tmp.name)
    C.CACHE_DIR = Path(folder)
    return Path(folder)


class CacheTests(unittest.TestCase):
    def test_finmind_key_ignores_token_and_adopts_old_cache(self):
        fresh_cache()
        ep = T.DEFAULT_ENDPOINTS
        old = C.key_for("finmind-v1", ep["finmind"], "TaiwanStockPrice", "2330", "")
        C.write(old, {"2026-01-05": [{"date": "2026-01-05", "close": 1}], "2026-01-06": []})
        calls = []
        def get(url, params=None, **kw):
            calls.append(params); return {"status": 200, "data": []}
        with patch.object(T, "http_get_json", side_effect=get), C.operation():
            rows = T.fm("TaiwanStockPrice", "2330", "2026-01-05", "2026-01-06", "brand-new-token", ep)
        self.assertEqual(rows, [{"date": "2026-01-05", "close": 1}])
        self.assertEqual(calls, [], "舊快取應被沿用，不該重抓")
        self.assertEqual(C.read(old), {}, "舊鍵應已搬走")
        self.assertNotIn(b"brand-new-token", (C.CACHE_DIR / "market.sqlite3").read_bytes())

    def test_t86_and_margin_are_stored_compact_and_parse_identically(self):
        folder = fresh_cache()
        filler = [["%04d" % n, "x"] + ["1,000"] * 17 for n in range(1000, 1400)]
        t86 = {"stat": "OK", "data": filler + [["2330", "台積電", "0", "0", "5,000,000", "0", "0", "1,000,000", "0", "0",
                                                "2,000,000", "0", "0", "0", "0", "0", "0", "0", "9,000,000"]]}
        mg_row = ["2330", "台積電", "0", "0", "0", "29,148", "28,763", "0", "0", "0", "0", "11", "15", "0", "0", ""]
        margin = {"stat": "OK", "tables": [{"data": [["融資", "1", "2"]]}, {"data": [mg_row]}]}
        day = {"stat": "OK", "title": "115年01月 2330 台積電 各日成交資訊",
               "data": [["115/01/05", "1,000,000", "1", "10", "11", "9", "10.5", "+0.5", "100"]]}
        def get(url, params=None, **kw):
            return day if "STOCK_DAY" in url else t86 if "T86" in url else margin
        with patch.object(T, "http_get_json", side_effect=get), patch.object(T.time, "sleep"), C.operation():
            raw = T.fetch_twse("2330", "2026-01-01", "2026-01-31", throttle=0, chip_days=5)
        self.assertEqual(raw["chips"]["2026-01-05"], {"foreign": 6000.0, "trust": 2000.0, "dealer": 1000.0})
        self.assertEqual(raw["margin"]["2026-01-05"],
                         {"margin_bal": 28763.0, "margin_prev": 29148.0, "short_bal": 15.0, "short_prev": 11.0})
        con = sqlite3.connect(str(folder / "market.sqlite3"))
        sizes = dict(con.execute("SELECT kind, MAX(LENGTH(payload)) FROM cache GROUP BY kind").fetchall())
        self.assertLess(sizes["market-day"], len(json.dumps(t86)) / 3, "全市場單日資料應明顯變小")

    def test_legacy_full_blob_is_converted_not_refetched(self):
        fresh_cache()
        url, params = T.DEFAULT_ENDPOINTS["twse_t86"], {"date": "20250102", "selectType": "ALL", "response": "json"}
        blob = {"stat": "OK", "data": [["2330", "n"] + ["0"] * 16 + ["3,000"]]}
        C.write(C.key_for("twse-v1", url, params), {"": blob})
        with patch.object(T, "http_get_json", side_effect=AssertionError("不該連網")), C.operation():
            j = T.twse_json(url, params, T._dt.date(2025, 1, 2), compact=T._compact_t86)
        self.assertEqual(j["rows"]["2330"], [0.0, 0.0, 3.0])   # 外資 0、投信 0、合計 3 張 → 自營商 3 張
        self.assertEqual(C.read(C.key_for("twse-v1", url, params)), {})

    def test_prune_removes_only_stale_rows(self):
        folder = fresh_cache()
        C.write("recent-market", {"": {"a": 1}}, kind="market-day")
        C.write("old-market", {"": {"a": 1}}, kind="market-day")
        C.write("series", {"2020-01-01": [], C.today().isoformat(): []})
        con = sqlite3.connect(str(folder / "market.sqlite3"))
        con.execute("UPDATE cache SET fetched=? WHERE key='old-market'", (time.time() - 300 * 86400,))
        con.commit(); con.close()
        self.assertEqual(C.prune(force=True), 2)
        self.assertEqual(C.prune(), 0, "一天內不重複清理")
        self.assertTrue(C.read("recent-market")); self.assertFalse(C.read("old-market"))
        self.assertEqual(list(C.read("series")), [C.today().isoformat()])


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.raw = T.fetch_demo("BT", days=260, seed=11)
        self.full = T.analyse("BT", self.raw, 120)

    def test_backtest_score_series_ends_at_todays_score(self):
        self.assertEqual(self.full["backtest"]["score_series"][-1], self.full["scores"]["overall"])

    def test_no_lookahead_historic_score_equals_score_computed_that_day(self):
        n = len(self.raw["bars"])
        for back in (1, 17, 60):
            cut = dict(self.raw, bars=self.raw["bars"][:n - back])
            then = T.analyse("BT", cut, 30)["scores"]["overall"]
            self.assertEqual(self.full["backtest"]["score_series"][-1 - back], then,
                             "%d 天前的歷史分數必須等於當天實際算出的分數" % back)

    def test_backtest_counts_are_consistent(self):
        b = self.full["backtest"]
        self.assertEqual(sum(r["days"] for r in b["rows"]), b["baseline"]["days"])
        self.assertEqual(sum(r["h5"]["n"] for r in b["rows"]), b["baseline"]["h5"]["n"])
        self.assertLessEqual(b["baseline"]["h10"]["n"], b["baseline"]["h5"]["n"])
        self.assertTrue(b["finding"])

    def test_short_history_has_no_backtest(self):
        self.assertIsNone(T.analyse("S", T.fetch_demo("S", days=70, seed=3), 30)["backtest"])

    def test_relative_strength_math_and_missing_benchmark(self):
        bars = self.raw["bars"]
        raw = dict(self.raw, bench={"id": "TAIEX", "name": "x", "series": {b["date"]: 100.0 for b in bars}})
        raw["bench"]["series"][bars[-1]["date"]] = 110.0
        d = T.analyse("BT", raw, 30)
        stock = (bars[-1]["close"] / bars[-21]["close"] - 1) * 100
        self.assertAlmostEqual(d["bench"]["d20"]["index"], 10.0, places=2)
        self.assertAlmostEqual(d["bench"]["d20"]["rs"], round(stock, 2) - 10.0, places=1)
        self.assertIsNone(T.analyse("BT", dict(self.raw, bench=None), 30)["bench"])
        del raw["bench"]["series"][bars[-21]["date"]]
        self.assertIsNone(T.analyse("BT", raw, 30)["bench"]["d20"], "缺基準日就不算，不用鄰近日頂替")

    def test_dividend_events_and_strict_parsing(self):
        d = self.full["dividends"]
        self.assertTrue(d["available"]); self.assertEqual(len(d["recent"]), 1); self.assertTrue(d["recent"][0]["in_view"])
        def get(url, params=None, **kw):
            ds = params["dataset"]
            if ds == "TaiwanStockPrice":
                return {"status": 200, "data": [{"date": "2026-01-05", "open": 1, "max": 1, "min": 1, "close": 1,
                                                 "Trading_Volume": 1000, "Trading_money": 1, "Trading_turnover": 1}]}
            if ds == "TaiwanStockDividendResult":
                return {"status": 200, "data": [{"date": "2026-01-05", "MarginPurchaseTodayBalance": 1},
                                                {"date": "2026-01-05", "stock_or_cache_dividend": "除息",
                                                 "stock_and_cache_dividend": 4.5, "before_price": 100, "reference_price": 95.5}]}
            return {"status": 200, "data": []}
        fresh_cache()
        with patch.object(T, "http_get_json", side_effect=get), C.operation():
            raw = T.fetch_finmind("2330", "2026-01-05", "2026-01-05", "")
        self.assertEqual(raw["dividends"], [{"date": "2026-01-05", "kind": "除息", "amount": 4.5,
                                             "before": 100.0, "reference": 95.5}])
        self.assertIsNone(raw["bench"])


class NetworkTests(unittest.TestCase):
    def test_4xx_is_not_retried_and_quota_is_explained(self):
        err = urllib.error.HTTPError("https://x.example/a", 402, "Payment Required", {}, io.BytesIO(b""))
        with patch.object(T.urllib.request, "urlopen", side_effect=err) as op, patch.object(T.time, "sleep"), C.operation():
            self.assertIsNone(T.http_get_json("https://x.example/a"))
            self.assertEqual(op.call_count, 1)
            self.assertTrue(any("查詢次數已達上限" in w for w in C.public_info()["warnings"]))

    def test_unreachable_host_is_skipped_but_other_hosts_still_tried(self):
        def opener(req, **kw):
            if "down.example" in req.full_url:
                raise urllib.error.URLError("no route")
            class R(io.BytesIO):
                def __enter__(self): return self
                def __exit__(self, *a): return False
            return R(b'{"ok":1}')
        with patch.object(T.urllib.request, "urlopen", side_effect=opener) as op, patch.object(T.time, "sleep"), C.operation():
            self.assertIsNone(T.http_get_json("https://down.example/a"))
            self.assertIsNone(T.http_get_json("https://down.example/b"))
            self.assertEqual(op.call_count, 1, "同一台主機第二次應直接略過")
            self.assertEqual(T.http_get_json("https://up.example/a"), {"ok": 1})


class WatchlistAndBatchTests(unittest.TestCase):
    def setUp(self):
        Path(os.environ["TWBOARD_WATCHLIST_FILE"]).unlink(missing_ok=True)

    def test_group_roundtrip_validation_and_hand_edited_file(self):
        self.assertEqual(S.save_group(" 半導體 ", "2330， 2303 2330"), {"半導體": ["2330", "2303"]})
        self.assertEqual(T.load_watchlists(), {"半導體": ["2330", "2303"]})
        for name, codes in (("", "2330"), ("x" * 31, "2330"), ("ok", ""), ("ok", "23-30"),
                            ("ok", ",".join(str(1000 + i) for i in range(9)))):
            with self.assertRaises(ValueError):
                S.save_group(name, codes)
        self.assertEqual(S.delete_group("半導體"), {})
        with self.assertRaises(ValueError):
            S.delete_group("半導體")
        Path(os.environ["TWBOARD_WATCHLIST_FILE"]).write_text('﻿{"手改": ["2330", "bad code!", 50], "壞": "x"}', encoding="utf-8")
        self.assertEqual(T.load_watchlists(), {"手改": ["2330", "50"]})
        Path(os.environ["TWBOARD_WATCHLIST_FILE"]).write_text("{not json", encoding="utf-8")
        self.assertEqual(T.load_watchlists(), {})

    def test_batch_writes_reports_index_and_summary(self):
        S.save_group("甲", "2330,2303"); S.save_group("乙", "2330")
        out = tempfile.mkdtemp(dir=_tmp.name)
        self.assertEqual(B.main(["--source", "demo", "--out", out, "--pause", "0"]), 0)
        folder = Path(out) / C.today().isoformat()
        names = sorted(p.name for p in folder.iterdir())
        self.assertEqual(len([n for n in names if n.endswith(".html")]), 3)          # 2 檔 + index
        index = (folder / "index.html").read_text(encoding="utf-8")
        self.assertIn("甲、乙", index); self.assertIn("2303_", index)
        rows = (folder / "summary.csv").read_text(encoding="utf-8-sig").strip().splitlines()
        self.assertEqual(len(rows), 3)
        import csv
        with (folder / "summary.csv").open(encoding="utf-8-sig", newline="") as f:
            records = list(csv.DictReader(f))
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertNotIn(None, record, "CSV 欄位與標頭需一致")
            self.assertIn("布林狀態", record)
            self.assertTrue(record["資料狀態"])
            self.assertNotEqual(record["布林帶寬%"], "")
            self.assertIn(record["布林狀態"], index)
        with self.assertRaises(SystemExit):
            B.main(["--group", "不存在", "--source", "demo", "--out", out])


if __name__ == "__main__":
    unittest.main()
