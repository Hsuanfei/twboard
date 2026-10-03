# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""1003a：資料依公布時間決定多久有效（日線當天有效、財報一季有效）＋ API 用量與連線狀態。

用一個本機的「假 FinMind」伺服器測試，不需要連網；時間用固定的台灣時間，結果不受執行時刻影響。
"""
import datetime as dt
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import twboard as T
import twcache as C
import twpower as P
import twserve as S
import twusage as U

TW = dt.timezone(dt.timedelta(hours=8))


def ts(y, m, d, hh=0, mm=0):
    return dt.datetime(y, m, d, hh, mm, tzinfo=TW).timestamp()


class FakeFinMind:
    """模擬 FinMind：/api/v4/data（依資料集回傳固定的資料）與 /v2/user_info。"""

    def __init__(self, last_day="2026-10-06"):
        self.calls, self.quota, self.last_day, self.slow = [], False, last_day, 0.0
        self.empty_quarters = {"2026-09-30"}       # 還沒公布的那一季
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
                if u.path == "/v2/user_info":
                    return self._send(200, {"user_count": 123, "api_request_limit": 1600})
                if u.path == "/control":          # 瀏覽器測試用：查詢次數、切換額度用完、讓回應變慢
                    if "quota" in q:
                        fake.quota = q["quota"] == "1"
                    if "slow" in q:
                        fake.slow = float(q["slow"])
                    return self._send(200, {"calls": len(fake.calls), "quota": fake.quota})
                fake.calls.append(q)
                if fake.slow:
                    time.sleep(fake.slow)
                if fake.quota:
                    return self._send(402, {"msg": "Requests reach the upper limit.", "status": 402})
                return self._send(200, {"msg": "success", "status": 200, "data": fake.rows(q)})

            def _send(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/api/v4/data" % self.server.server_address[1]
        self.control = "http://127.0.0.1:%d/control" % self.server.server_address[1]
        self.user_info = "http://127.0.0.1:%d/v2/user_info" % self.server.server_address[1]

    def close(self):
        self.server.shutdown(); self.server.server_close()

    def days(self, q):
        out, d = [], dt.date.fromisoformat(q["start_date"])
        stop = min(dt.date.fromisoformat(q["end_date"]), dt.date.fromisoformat(self.last_day))
        while d <= stop:
            if d.weekday() < 5:
                out.append(d.isoformat())
            d += dt.timedelta(days=1)
        return out

    def rows(self, q):
        ds, sid = q.get("dataset"), q.get("data_id", "")
        if ds == "TaiwanStockInfo":
            return [{"stock_id": "2330", "stock_name": "台積電", "type": "twse", "industry_category": "半導體業", "date": "2026-10-01"}]
        if ds == "TaiwanStockPrice":
            return [{"date": d, "stock_id": sid, "open": 100 + i % 7, "max": 103 + i % 7, "min": 98 + i % 7, "close": 101 + i % 5,
                     "Trading_Volume": 3000000, "Trading_money": 1, "Trading_turnover": 1} for i, d in enumerate(self.days(q))]
        if ds == "TaiwanStockInstitutionalInvestorsBuySell":
            return [{"date": d, "stock_id": sid, "name": "Foreign_Investor", "buy": 2000000, "sell": 1000000} for d in self.days(q)]
        if ds == "TaiwanStockMarginPurchaseShortSale":
            return [{"date": d, "stock_id": sid, "MarginPurchaseTodayBalance": 100, "MarginPurchaseYesterdayBalance": 99,
                     "ShortSaleTodayBalance": 5, "ShortSaleYesterdayBalance": 5} for d in self.days(q)]
        if ds in ("TaiwanStockFinancialStatements", "TaiwanStockCashFlowsStatement"):
            out = []
            for d in self.days(q) + [x for x in ("2026-03-31", "2026-06-30", "2026-09-30")
                                     if q["start_date"] <= x <= q["end_date"]]:
                if d[5:] in ("03-31", "06-30", "09-30", "12-31") and d not in self.empty_quarters:
                    out.append({"date": d, "stock_id": sid, "type": "Revenue", "value": 1000, "origin_name": "營業收入合計"})
            return list({r["date"]: r for r in out}.values())
        return []

    def by_dataset(self, start=0):
        out = {}
        for c in self.calls[start:]:
            out[c.get("dataset")] = out.get(c.get("dataset"), 0) + 1
        return out


class Base(unittest.TestCase):
    """固定時間：2026-10-07（星期三）。"""
    NOW = ts(2026, 10, 7, 10, 0)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(C.close_cache)
        self.now = self.NOW
        for name, value in (("CACHE_DIR", Path(self.temp.name)), ("clock", lambda: self.now),
                            ("today", lambda: dt.datetime.fromtimestamp(self.now, TW).date())):
            p = patch.object(C, name, value); p.start(); self.addCleanup(p.stop)
        U.reset()
        self.addCleanup(U.reset)


class ScheduleTests(unittest.TestCase):
    def test_taiwan_daily_release_times(self):
        s = C.TW_DAILY
        self.assertEqual(s.next_release(ts(2026, 10, 7, 10)), ts(2026, 10, 7, 14, 30))
        self.assertEqual(s.next_release(ts(2026, 10, 7, 15)), ts(2026, 10, 7, 17, 45))
        self.assertEqual(s.next_release(ts(2026, 10, 7, 22)), ts(2026, 10, 8, 8), "晚上抓過，隔天早上才再確認")
        self.assertEqual(s.next_release(ts(2026, 10, 9, 22)), ts(2026, 10, 10, 8), "週五晚上 → 週六早上補確認一次")
        self.assertEqual(s.next_release(ts(2026, 10, 10, 9)), ts(2026, 10, 12, 14, 30), "週末不查")
        self.assertEqual(s.due("2026-10-07"), ts(2026, 10, 7, 14, 30), "收盤前不可能有當天資料")

    def test_us_and_quarterly(self):
        self.assertEqual(C.US_DAILY.due("2026-10-09"), ts(2026, 10, 10, 5, 30), "美股週五的收盤要到台灣週六清晨")
        q = C.QUARTERLY
        self.assertTrue(q.quarter_end("2026-09-30")); self.assertFalse(q.quarter_end("2026-09-29"))
        self.assertEqual(q.deadline("2026-09-30"), ts(2026, 11, 15) + 10 * 86400)
        self.assertEqual(q.deadline("2026-12-31"), ts(2027, 4, 1) + 10 * 86400, "年報期限是隔年 3 月底")
        self.assertEqual(q.next_check(ts(2026, 10, 7, 10)), ts(2026, 10, 12, 9), "公布期間每週一確認")


class DailyCachePolicyTests(Base):
    def fetch(self, log):
        def f(a, b):
            log.append((a, b))
            return [{"date": d, "v": 1} for d in C.dates(a, b) if dt.date.fromisoformat(d).weekday() < 5 and
                    C.clock() >= C.TW_DAILY.due(d)]
        return f

    def test_today_is_not_queried_before_close_and_results_last_until_next_release(self):
        log = []
        with C.operation():
            rows = C.range_data("k", "2026-09-01", "2026-10-07", self.fetch(log))
        self.assertEqual(log, [("2026-09-01", "2026-10-06")], "收盤前（10:00）不查今天")
        self.assertEqual(rows[-1]["date"], "2026-10-06")
        self.now = ts(2026, 10, 7, 14, 29)
        C.range_data("k", "2026-09-01", "2026-10-07", self.fetch(log))
        self.assertEqual(len(log), 1, "下一次公布（14:30）以前都直接用本機資料庫")
        self.now = ts(2026, 10, 7, 14, 35)
        rows = C.range_data("k", "2026-09-01", "2026-10-07", self.fetch(log))
        self.assertEqual(log[-1], ("2026-09-30", "2026-10-07"), "收盤後只重新確認近 7 日")
        self.assertEqual(rows[-1]["date"], "2026-10-07")
        self.now = ts(2026, 10, 7, 17, 0)
        C.range_data("k", "2026-09-01", "2026-10-07", self.fetch(log))
        self.assertEqual(len(log), 2)
        self.now = ts(2026, 10, 8, 7, 59)
        self.assertEqual(len(log), 2)

    def test_old_days_are_final_but_missing_required_days_retry_at_next_release(self):
        log = []
        C.range_data("old", "2026-08-01", "2026-08-31", lambda a, b: log.append((a, b)) or [])
        self.now = ts(2026, 10, 20, 15)
        C.range_data("old", "2026-08-01", "2026-08-31", lambda a, b: log.append((a, b)) or [])
        self.assertEqual(len(log), 1, "超過 7 天的日子抓過就定案")
        C.range_data("old", "2026-08-01", "2026-08-31", lambda a, b: log.append((a, b)) or [], required_dates=["2026-08-05"])
        self.assertEqual(log[-1], ("2026-08-05", "2026-08-05"), "股價有、法人沒有的日子：下一次公布時間到了才再查")
        C.range_data("old", "2026-08-01", "2026-08-31", lambda a, b: log.append((a, b)) or [], required_dates=["2026-08-05"])
        self.assertEqual(len(log), 2)

    def test_refresh_button_and_complete_check_ignore_not_due_days(self):
        log = []
        C.range_data("r", "2026-10-01", "2026-10-07", self.fetch(log))
        C.range_data("r", "2026-10-01", "2026-10-07", self.fetch(log), refresh_recent=True)
        self.assertEqual(len(log), 2, "按「重抓」不管有效期限")
        self.assertEqual(C.range_data("only-today", "2026-10-07", "2026-10-07", self.fetch(log), require_complete=True), [],
                         "收盤前只要今天：不查，也不算失敗")
        self.assertEqual(len(log), 2)

    def test_response_follows_schedule(self):
        n = []
        get = lambda: n.append(1) or {"stat": "OK"}
        valid = lambda j: j.get("stat") == "OK"
        C.response("resp", get, valid, None, schedule="tw_official")
        self.now = ts(2026, 10, 7, 14, 0)
        C.response("resp", get, valid, None, schedule="tw_official")
        self.assertEqual(len(n), 1)
        self.now = ts(2026, 10, 7, 14, 31)
        C.response("resp", get, valid, None, schedule="tw_official")
        self.assertEqual(len(n), 2)


class QuarterlyPolicyTests(Base):
    def test_statements_valid_for_the_quarter(self):
        log = []
        def fetch(a, b):
            log.append((a, b))
            return [{"date": d} for d in ("2026-03-31", "2026-06-30") if a <= d <= b]
        C.range_data("fin", "2025-01-01", "2026-10-07", fetch, schedule="quarterly")
        self.now = ts(2026, 10, 11, 20)
        C.range_data("fin", "2025-01-01", "2026-10-07", fetch, schedule="quarterly")
        self.assertEqual(len(log), 1, "第三季還沒公布：等到週一才再確認")
        self.now = ts(2026, 10, 12, 9, 1)
        C.range_data("fin", "2025-01-01", "2026-10-12", fetch, schedule="quarterly")
        self.assertEqual(log[-1], ("2026-09-30", "2026-09-30"), "只確認還沒到手的季底，其他日子都定案")
        def published(a, b):
            log.append((a, b)); return [{"date": "2026-09-30"}]
        self.now = ts(2026, 10, 19, 9, 1)
        rows = C.range_data("fin", "2025-01-01", "2026-10-19", published, schedule="quarterly")
        self.assertEqual(rows[-1]["date"], "2026-09-30")
        n = len(log)
        self.now = ts(2026, 12, 28, 9, 1)
        C.range_data("fin", "2025-01-01", "2026-10-19", published, schedule="quarterly")
        self.assertEqual(len(log), n, "到手之後一季內都不再查")

    def test_past_deadline_empty_quarter_is_final(self):
        self.now = ts(2026, 1, 20, 10)
        log = []
        C.range_data("fin2", "2025-12-01", "2026-01-10", lambda a, b: log.append(1) or [], schedule="quarterly")
        self.now = ts(2026, 6, 1, 10)
        C.range_data("fin2", "2025-12-01", "2026-01-10", lambda a, b: log.append(1) or [], schedule="quarterly")
        self.assertEqual(len(log), 2, "期限前抓過、期限後再確認一次")
        self.now = ts(2026, 6, 15, 10)
        C.range_data("fin2", "2025-12-01", "2026-01-10", lambda a, b: log.append(1) or [], schedule="quarterly")
        self.assertEqual(len(log), 2, "期限過後確認過仍沒有：定案")


class EndToEndTests(Base):
    """用假 FinMind 跑真的程式碼：第二次分析同一檔不必再連網；財報一季有效；用量計數與 402。"""

    def setUp(self):
        super().setUp()
        self.fake = FakeFinMind()
        self.addCleanup(self.fake.close)
        self.ep = T.endpoints({"finmind": self.fake.url})

    def analyse(self):
        with C.operation():
            return T.fetch_raw("2330", 60, "finmind", "", self.ep, throttle=0, verbose=False)

    def test_second_analysis_uses_disk_cache_until_next_release(self):
        raw = self.analyse()
        self.assertEqual(raw["bars"][-1]["date"], "2026-10-06")
        first = len(self.fake.calls)
        self.assertGreater(first, 3)
        self.now = ts(2026, 10, 7, 13, 0)
        self.analyse()
        self.assertEqual(len(self.fake.calls), first, "同一個公布時段內換股再回來：0 次查詢")
        self.now = ts(2026, 10, 7, 18, 0)
        self.fake.last_day = "2026-10-07"
        raw = self.analyse()
        self.assertEqual(raw["bars"][-1]["date"], "2026-10-07")
        again = self.fake.calls[first:]
        self.assertTrue(all(c["start_date"] >= "2026-09-30" for c in again if c["dataset"] != "TaiwanStockInfo"),
                        "公布時間過後只補近 7 日：%s" % again)
        snap = U.snapshot("")
        fm = snap["finmind"]
        self.assertEqual(fm["used"], len(self.fake.calls), "用量＝實際送到 FinMind 的次數")
        self.assertEqual((fm["limit"], fm["basis"]), (300, "local"))
        src = [s for s in snap["sources"] if s["name"] == "FinMind"][0]
        self.assertEqual(src["state"], "ok")
        self.assertGreater(snap["cache"]["hits_hour"], 0)

    def test_statements_are_not_refetched_within_the_quarter(self):
        live = lambda: P.Live("2330", "", self.ep)
        with C.operation():
            q = live().statements()
        self.assertEqual(q[-1]["q"], "26Q2")
        n = self.fake.by_dataset().get("TaiwanStockFinancialStatements")
        self.now = ts(2026, 10, 9, 20)
        with C.operation():
            live().statements()
        self.assertEqual(self.fake.by_dataset().get("TaiwanStockFinancialStatements"), n)
        self.fake.empty_quarters = set()
        self.now = ts(2026, 10, 12, 9, 30)
        with C.operation():
            q = live().statements()
        self.assertEqual(q[-1]["q"], "26Q3", "公布期間的週一確認到新的一季")

    def test_quota_and_connection_errors_show_reason(self):
        self.fake.quota = True
        with C.operation() as st:
            self.assertIsNone(T.fm("TaiwanStockPrice", "2330", "2026-10-01", "2026-10-06", "", self.ep))
            self.assertTrue(any("上限" in w for w in st["warnings"]))
        snap = U.snapshot("")
        fm_src = [s for s in snap["sources"] if s["name"] == "FinMind"][0]
        self.assertEqual(fm_src["state"], "limit")
        self.assertEqual(fm_src["error"], "查詢次數已達上限")
        self.assertIsNotNone(snap["finmind"]["quota_at"])
        # 連不上的網站：說明原因，而且不算 FinMind 額度
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        dead = "http://127.0.0.1:%d/x" % port
        U.register(dead, "證交所")
        before = snap["finmind"]["used"]
        with C.operation():
            self.assertIsNone(T.http_get_json(dead, {"date": "20261006"}, retries=1))
        snap = U.snapshot("")
        twse = [s for s in snap["sources"] if s["name"] == "證交所"][0]
        self.assertEqual(twse["state"], "error")
        self.assertIn("拒絕", twse["error"])
        self.assertEqual(snap["finmind"]["used"], before)

    def test_official_usage_with_token_and_custom_host(self):
        self.assertEqual(U.source_of(self.fake.url), "FinMind", "自訂的 FinMind 網址仍歸到 FinMind")
        with patch.object(U, "USER_INFO_URL", self.fake.user_info):
            U.refresh_official("secret-token", wait=True)
            snap = U.snapshot("secret-token")
        self.assertEqual(snap["finmind"]["basis"], "official")
        self.assertEqual((snap["finmind"]["used"], snap["finmind"]["limit"], snap["finmind"]["remaining"]), (123, 1600, 1477))
        self.assertNotIn("secret-token", json.dumps(snap))
        self.assertNotIn(b"secret-token", (Path(self.temp.name) / "market.sqlite3").read_bytes())

    def test_usage_survives_restart_and_inflight_is_visible(self):
        with C.operation():
            T.fm("TaiwanStockPrice", "2330", "2026-10-01", "2026-10-06", "", self.ep)
        n = len(self.fake.calls)
        C.close_cache(); U.reset(); T.endpoints({"finmind": self.fake.url})
        self.assertEqual(U.snapshot("")["finmind"]["used"], n, "重開程式後仍記得這一小時用了幾次")
        rid = U.begin(self.fake.url, {"dataset": "TaiwanStockPrice", "data_id": "2330", "start_date": "x"})
        with U._lock:
            U._inflight[rid]["start"] -= 12
        snap = U.snapshot("")
        fm_src = [s for s in snap["sources"] if s["name"] == "FinMind"][0]
        self.assertEqual(fm_src["state"], "slow")
        self.assertEqual(fm_src["inflight"][0]["what"], "TaiwanStockPrice 2330")
        U.end(rid, True, 200)


class ServerTests(Base):
    def setUp(self):
        super().setUp()
        self.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, path, obj):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode(),
                                     headers={"Content-Type": "application/json", "Origin": self.base})
        return json.loads(urllib.request.urlopen(req, timeout=10).read())

    def test_usage_endpoint_and_clear(self):
        C.write("some-key", {"2026-10-01": [{"date": "2026-10-01"}]})
        j = json.loads(urllib.request.urlopen(self.base + "/api/usage", timeout=10).read())
        self.assertTrue(j["ok"])
        d = j["data"]
        self.assertEqual([s["name"] for s in d["sources"]][:3], ["FinMind", "證交所", "櫃買中心"])
        self.assertEqual(d["cache"]["rows"], 1)
        self.assertTrue(d["cache"]["rules"])
        with self.assertRaises(urllib.error.HTTPError):
            self.post("/api/cache/clear", {"confirm": "no"})
        with S._lock:
            S._jobs["busy"] = {"status": "running", "updated": 0}
        try:
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.post("/api/cache/clear", {"confirm": "yes"})
            self.assertIn("進行", json.loads(e.exception.read())["error"])
        finally:
            with S._lock:
                S._jobs.pop("busy", None)
        r = self.post("/api/cache/clear", {"confirm": "yes"})
        self.assertEqual(r["data"]["removed"], 1)
        self.assertEqual(C.read("some-key"), {})

    def test_page_has_usage_widget(self):
        html = urllib.request.urlopen(self.base + "/", timeout=10).read().decode()
        self.assertIn('id="usage"', html); self.assertIn("window.TWUsage", html); self.assertNotIn("/*__USAGEJS__*/", html)
        self.assertIn("台股戰略產生器1003a版", html)


if __name__ == "__main__":
    unittest.main()
