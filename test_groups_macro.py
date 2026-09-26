# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""自選群組上限與逐檔編輯；總體市場面板（匯率與大盤）的取得、備援與輸出。"""
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

_tmp = tempfile.TemporaryDirectory()
os.environ["TWBOARD_CACHE_DIR"] = str(Path(_tmp.name) / "cache")
os.environ["TWBOARD_WATCHLIST_FILE"] = str(Path(_tmp.name) / "watchlists.json")
os.environ["TWBOARD_FILTER_FILE"] = str(Path(_tmp.name) / "filters.json")

import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twmacro as M           # noqa: E402
import twserve as S           # noqa: E402


def fresh_cache():
    C.CACHE_DIR = Path(tempfile.mkdtemp(dir=_tmp.name))


class GroupTests(unittest.TestCase):
    def setUp(self):
        Path(os.environ["TWBOARD_WATCHLIST_FILE"]).unlink(missing_ok=True)

    def test_limits_five_groups_eight_stocks(self):
        for i in range(5):
            S.save_group("g%d" % i, "2330")
        with self.assertRaisesRegex(ValueError, "上限（5 個）"):
            S.save_group("g5", "2330")
        S.save_group("g0", ",".join(str(1000 + i) for i in range(8)))          # 既有群組可覆寫，8 檔剛好
        with self.assertRaisesRegex(ValueError, "1～8"):
            S.save_group("g0", ",".join(str(1000 + i) for i in range(9)))

    def test_add_remove_one_stock_at_a_time(self):
        S.save_group("半導體", "2330,2303")
        self.assertEqual(S.edit_group("半導體", add="2454")["半導體"], ["2330", "2303", "2454"])
        self.assertEqual(S.edit_group("半導體", add="2330")["半導體"], ["2330", "2303", "2454"], "重複加入不變")
        self.assertEqual(S.edit_group("半導體", remove="2303")["半導體"], ["2330", "2454"])
        self.assertEqual(S.edit_group("半導體", remove="9999")["半導體"], ["2330", "2454"], "移除不存在的代號不報錯")
        S.edit_group("半導體", add="1,2,3,4,5,6".replace(",", "0,") + "0")   # 補到 8
        self.assertEqual(len(S.load_groups()["半導體"]), 8)
        with self.assertRaisesRegex(ValueError, "最多 8 檔"):
            S.edit_group("半導體", add="8888")
        self.assertEqual(S.edit_group("新組", add="0050"), {"半導體": S.load_groups()["半導體"], "新組": ["0050"]}, "加入即建立")
        self.assertNotIn("新組", S.edit_group("新組", remove="0050"), "移到空就刪除群組")
        with self.assertRaises(ValueError):
            S.edit_group("不存在", remove="2330")
        with self.assertRaises(ValueError):
            S.edit_group("半導體")
        for i in range(4):
            S.save_group("x%d" % i, "2330")
        with self.assertRaisesRegex(ValueError, "上限"):
            S.edit_group("第六組", add="2330")

    def test_legacy_oversized_group_is_kept_not_truncated(self):
        Path(os.environ["TWBOARD_WATCHLIST_FILE"]).write_text(json.dumps({"舊": [str(2000 + i) for i in range(10)]}), encoding="utf-8")
        self.assertEqual(len(T.load_watchlists()["舊"]), 10)
        with self.assertRaisesRegex(ValueError, "放不下"):
            S.edit_group("舊", add="2330")
        self.assertEqual(len(S.edit_group("舊", remove="2000,2001,2002")["舊"]), 7)


class MacroTests(unittest.TestCase):
    def setUp(self):
        fresh_cache()

    def test_demo_build_shape(self):
        with C.operation():
            m = M.build(30, source="demo")
        self.assertEqual([s["id"] for s in m["series"]], ["USDTWD", "TAIEX", "^GSPC", "^IXIC", "^N225"])
        for s in m["series"]:
            self.assertTrue(s["available"]); self.assertEqual(s["count"], 30)
            self.assertEqual(len(s["series"][0]), 2)
        self.assertEqual(m["missing"], [])
        self.assertLessEqual(m["days"], 500)

    def test_fx_uses_spot_mid_and_skips_blank_days(self):
        rows = [{"date": "2026-01-05", "currency": "USD", "cash_buy": 31.5, "cash_sell": 32.1, "spot_buy": 31.8, "spot_sell": 31.9},
                {"date": "2026-01-06", "currency": "USD", "cash_buy": "-", "cash_sell": "-", "spot_buy": "-", "spot_sell": "-"},
                {"date": "2026-01-07", "currency": "USD", "cash_buy": 31.6, "cash_sell": 32.2, "spot_buy": None, "spot_sell": None}]
        def get(url, params=None, **kw):
            return {"status": 200, "data": rows} if params.get("dataset") == "TaiwanExchangeRate" else {"status": 200, "data": []}
        with patch.object(T, "http_get_json", side_effect=get), C.operation():
            out, label = M.fetch_series(M.SERIES[0], "2026-01-05", "2026-01-07", "", T.DEFAULT_ENDPOINTS)
        # 0922b 起只採即期買賣中價；沒有即期報價的日子不用現金匯率湊，直接略過。
        self.assertEqual(out, [{"date": "2026-01-05", "value": 31.85}])
        self.assertIn("台銀", label)

    def test_us_index_falls_back_to_stooq_csv(self):
        csv_text = "Date,Open,High,Low,Close,Volume\n2026-01-05,1,2,0.5,38000.5,0\n2026-01-06,1,2,0.5,38100.25,0\nbad,,,,,\n"
        calls = []
        def get(url, params=None, raw_text=False, **kw):
            calls.append((url, params.get("dataset") or params.get("s")))
            if "finmindtrade" in url:
                return {"status": 200, "data": []}
            return csv_text if raw_text else None
        with patch.object(T, "http_get_json", side_effect=get), C.operation():
            out, label = M.fetch_series(M.SERIES[4], "2026-01-05", "2026-01-06", "", T.DEFAULT_ENDPOINTS)
        self.assertEqual(label, "Stooq")
        self.assertEqual(out, [{"date": "2026-01-05", "value": 38000.5}, {"date": "2026-01-06", "value": 38100.25}])
        self.assertEqual([c[1] for c in calls], ["USStockPrice", "^nkx"])
        # 第二次同區間應走快取，不再連網
        calls.clear()
        with patch.object(T, "http_get_json", side_effect=get), C.operation():
            M.fetch_series(M.SERIES[4], "2026-01-05", "2026-01-06", "", T.DEFAULT_ENDPOINTS)
        self.assertEqual([c for c in calls if c[1] == "^nkx"], [], "Stooq 結果應已快取")

    def test_unavailable_series_is_reported_not_faked(self):
        with patch.object(T, "http_get_json", return_value=None), C.operation():
            m = M.build(20, source="auto")
        self.assertEqual(len(m["missing"]), 5)
        self.assertTrue(all(not s["available"] and s["series"] == [] for s in m["series"]))

    def test_changes_are_computed_from_the_trimmed_window(self):
        with C.operation():
            m = M.build(30, source="demo")
        s = m["series"][1]
        v = [p[1] for p in s["series"]]
        self.assertAlmostEqual(s["d1"]["pct"], round((v[-1] / v[-2] - 1) * 100, 2), places=1)
        self.assertAlmostEqual(s["window_pct"], round((v[-1] / v[0] - 1) * 100, 2), places=1)
        self.assertEqual(s["high"], max(v)); self.assertEqual(s["low"], min(v))

    def test_server_endpoint_and_export_attachment(self):
        S.DEMO_MODE = True
        server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = "http://127.0.0.1:%d" % server.server_address[1]
            with urllib.request.urlopen(base + "/api/macro?days=40", timeout=20) as r:
                j = json.loads(r.read().decode("utf-8"))
            self.assertTrue(j["ok"]); self.assertEqual(j["data"]["days"], 40)     # 伺服器照要求給；「至少 60 日」是前端的預設
            req = urllib.request.Request(base + "/api/analyse", data=json.dumps({"code": "2330", "days": 30}).encode("utf-8"),
                                         headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:%d" % server.server_address[1]})
            with urllib.request.urlopen(req, timeout=30) as r:
                snap = json.loads(r.read().decode("utf-8"))["data"]["snapshot_id"]
            # 0922b 起匯出要明確指定市場快照；沒指定就不附市場面板資料，失效的快照會被拒絕而不是換成別的資料。
            with urllib.request.urlopen(base + "/api/export?snapshot=" + snap, timeout=30) as r:
                html = r.read().decode("utf-8")
            self.assertIn('id="macro"', html); self.assertNotIn('"USDTWD"', html); self.assertIn("renderMacro", html)
            with urllib.request.urlopen(base + "/api/export?snapshot=" + snap + "&macro_snapshot=" + j["data"]["snapshot_id"], timeout=30) as r:
                html = r.read().decode("utf-8")
            self.assertIn('"USDTWD"', html)
            try:
                urllib.request.urlopen(base + "/api/export?snapshot=" + snap + "&macro_snapshot=expired", timeout=30)
                self.fail("失效的市場快照應被拒絕")
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 400)
        finally:
            server.shutdown(); server.server_close(); S.DEMO_MODE = False


if __name__ == "__main__":
    unittest.main()
