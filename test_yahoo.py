# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""20260925c：Yahoo 財經當作美、日指數的第三備援（預設關閉）。"""
import datetime as dt
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-yh-"))
import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twmacro as M           # noqa: E402
import twserve as S           # noqa: E402

JST = 9 * 3600


def ts(day, hour_local=9, offset=JST):
    d = dt.datetime.fromisoformat(day).replace(hour=hour_local, tzinfo=dt.timezone.utc)
    return int(d.timestamp()) - offset


def chart(days, closes, offset=JST, live=None):
    meta = {"symbol": "^N225", "gmtoffset": offset, "exchangeTimezoneName": "Asia/Tokyo"}
    if live:
        meta["currentTradingPeriod"] = {"regular": {"start": live[0], "end": live[1], "gmtoffset": offset}}
    return {"chart": {"result": [{"meta": meta, "timestamp": [ts(d, offset=offset) for d in days],
                                  "indicators": {"quote": [{"close": closes}]}}], "error": None}}


class ParseTests(unittest.TestCase):
    def test_local_dates_nulls_and_range(self):
        days = ["2026-09-21", "2026-09-22", "2026-09-24", "2026-09-25"]
        j = chart(days, [38000.5, None, 38500.25, 38600])
        now = ts("2026-09-26", 12)                                   # 週六，全部都已收盤
        j["chart"]["result"][0]["meta"]["currentTradingPeriod"] = {"regular": {"start": ts("2026-09-25"), "end": ts("2026-09-25", 15, JST) + 1800}}
        out = M.parse_yahoo_chart(j, "2026-09-22", "2026-09-30", now=now)
        self.assertEqual(out, [{"date": "2026-09-24", "value": 38500.25}, {"date": "2026-09-25", "value": 38600.0}],
                         "空值略過、只收查詢區間、日期用東京時間")

    def test_bar_still_trading_is_dropped(self):
        live = (ts("2026-09-25", 9), ts("2026-09-25", 15) + 1800)          # 09:00～15:30 JST
        j = chart(["2026-09-24", "2026-09-25"], [38500, 38777], live=live)
        during = M.parse_yahoo_chart(j, "2026-09-01", "2026-09-30", now=live[0] + 3600)
        self.assertEqual([r["date"] for r in during], ["2026-09-24"], "盤中的當天不存，免得把盤中價當收盤")
        after = M.parse_yahoo_chart(j, "2026-09-01", "2026-09-30", now=live[1] + 3600)
        self.assertEqual([r["date"] for r in after], ["2026-09-24", "2026-09-25"])

    def test_without_trading_period_today_is_skipped(self):
        j = chart(["2026-09-24", "2026-09-25"], [1, 2])
        out = M.parse_yahoo_chart(j, "2026-09-01", "2026-09-30", now=ts("2026-09-25", 20))
        self.assertEqual([r["date"] for r in out], ["2026-09-24"])

    def test_us_offset_and_errors(self):
        j = chart(["2026-09-24"], [6500.0], offset=-4 * 3600)
        j["chart"]["result"][0]["timestamp"] = [ts("2026-09-24", 9, -4 * 3600) + 1800]   # 09:30 紐約時間
        out = M.parse_yahoo_chart(j, "2026-09-01", "2026-09-30", now=ts("2026-09-26", 0))
        self.assertEqual(out, [{"date": "2026-09-24", "value": 6500.0}])
        self.assertIsNone(M.parse_yahoo_chart({"chart": {"result": None, "error": {"code": "Not Found"}}}, "a", "b"))
        self.assertIsNone(M.parse_yahoo_chart(None, "a", "b"))
        self.assertIsNone(M.parse_yahoo_chart("<html>", "a", "b"))


class FallbackTests(unittest.TestCase):
    def setUp(self):
        C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-yh-"))
        self.calls = []

    def fake(self, url, params=None, raw_text=False, **kw):
        self.calls.append(url)
        if "finmind" in url:
            return {"status": 200, "data": []}                   # FinMind 沒有日經
        if "stooq" in url:
            return "No data"                                       # Stooq 也沒有
        if "yahoo" in url:
            end = dt.date.fromtimestamp(params["period2"]) - dt.timedelta(days=3)
            days = [(end - dt.timedelta(days=i)).isoformat() for i in range(20, 0, -1)
                    if (end - dt.timedelta(days=i)).weekday() < 5]
            return chart(days, [38000 + i for i in range(len(days))])
        raise AssertionError(url)

    def ep(self, yahoo):
        return dict(T.DEFAULT_ENDPOINTS, _yahoo=yahoo)

    def spec(self):
        return next(s for s in M.SERIES if s["id"] == "^N225")

    def test_disabled_by_default(self):
        end = C.today(); start = end - dt.timedelta(days=40)
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation():
            rows, label = M.fetch_series(self.spec(), start.isoformat(), end.isoformat(), "", self.ep(False))
        self.assertEqual((rows, label), ([], None))
        self.assertFalse(any("yahoo" in u for u in self.calls), "沒勾選就不能查 Yahoo")
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation():
            rows, label = M.fetch_series(self.spec(), start.isoformat(), end.isoformat(), "", T.DEFAULT_ENDPOINTS)
        self.assertEqual(label, None, "沒有 _yahoo 設定時也視為關閉")

    def test_enabled_uses_yahoo_as_last_resort(self):
        end = C.today(); start = end - dt.timedelta(days=40)
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation():
            rows, label = M.fetch_series(self.spec(), start.isoformat(), end.isoformat(), "", self.ep(True))
        self.assertEqual(label, M.YAHOO_LABEL)
        self.assertTrue(rows and all(start.isoformat() <= r["date"] <= end.isoformat() for r in rows))
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation() as st:
            C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-yh-"))
            with C.bind(st, "日經 225"):
                M.fetch_series(self.spec(), start.isoformat(), end.isoformat(), "", self.ep(True))
        self.assertFalse([w for w in st["warnings"] if w.startswith("日經 225")],
                         "Yahoo 取得新資料後，前面 FinMind／Stooq 失敗的警示不再顯示：%s" % st["warnings"])
        order = [("finmind" in u and "f") or ("stooq" in u and "s") or "y" for u in self.calls]
        self.assertEqual(order[:3], ["f", "s", "y"], "順序：FinMind → Stooq → Yahoo")
        self.assertIn("%5EN225", [u for u in self.calls if "yahoo" in u][0])

    def test_yahoo_not_used_when_finmind_is_fresh(self):
        def fresh(url, params=None, raw_text=False, **kw):
            self.calls.append(url)
            if "finmind" in url:
                d = dt.date.fromisoformat(params["end_date"])
                days = [(d - dt.timedelta(days=i)) for i in range(10)]
                return {"status": 200, "data": [{"date": x.isoformat(), "stock_id": "^N225", "Close": 38000}
                                                 for x in days if x.weekday() < 5 and x.isoformat() >= params["start_date"]]}
            raise AssertionError("不該查其他來源：" + url)
        end = C.today(); start = end - dt.timedelta(days=20)
        with patch.object(T, "http_get_json", side_effect=fresh), C.operation():
            rows, label = M.fetch_series(self.spec(), start.isoformat(), end.isoformat(), "", self.ep(True))
        self.assertEqual(label, "FinMind")


class ServerTests(unittest.TestCase):
    def setUp(self):
        C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-yh-"))
        S._macro_cache.clear()
        self.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()

    def test_macro_toggle_is_part_of_cache_key(self):
        seen = []
        def fake(url, params=None, raw_text=False, **kw):
            seen.append(url)
            return FallbackTests.fake(self_ref, url, params, raw_text, **kw)
        self_ref = FallbackTests(); self_ref.calls = []
        with patch.object(T, "http_get_json", side_effect=fake):
            with urllib.request.urlopen(self.base + "/api/macro?days=30", timeout=30) as r:
                off = json.loads(r.read())["data"]
            with urllib.request.urlopen(self.base + "/api/macro?days=30&yahoo=1", timeout=30) as r:
                on = json.loads(r.read())["data"]
        nk = lambda d: next(s for s in d["series"] if s["id"] == "^N225")
        self.assertFalse(nk(off)["available"])
        self.assertTrue(nk(on)["available"]); self.assertEqual(nk(on)["source"], M.YAHOO_LABEL)

    def test_diagnose_includes_yahoo_only_when_opted_in(self):
        class Resp:
            status = 200
            def __init__(self, b): self.b = b.encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return self.b
        real = urllib.request.urlopen
        def urlopen(req, timeout=None, context=None):
            if isinstance(req, str):                    # 測試自己呼叫本機伺服器
                return real(req, timeout=timeout)
            if "yahoo" in req.full_url:
                return Resp(json.dumps(chart(["2026-09-22", "2026-09-23"], [1, 2])))
            return Resp(json.dumps({"status": 200, "data": []}))
        with patch.object(T.urllib.request, "urlopen", side_effect=urlopen):
            with urllib.request.urlopen(self.base + "/api/diagnose", timeout=30) as r:
                plain = json.loads(r.read())["data"]["checks"]
            with urllib.request.urlopen(self.base + "/api/diagnose?yahoo=1", timeout=30) as r:
                withy = json.loads(r.read())["data"]["checks"]
        self.assertFalse(any("Yahoo" in c["source"] for c in plain))
        y = [c for c in withy if "Yahoo" in c["source"]]
        self.assertEqual(len(y), 1); self.assertTrue(y[0]["ok"])


if __name__ == "__main__":
    unittest.main()
