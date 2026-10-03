# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""0922c 加速相關：平行抓取、近期資料「已到手就不再確認」、多檔同時排隊、警示結果短快取。"""
import datetime as dt
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-perf-"))
import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twmacro as M           # noqa: E402
import twserve as S           # noqa: E402


def fresh_cache():
    folder = Path(tempfile.mkdtemp(prefix="twboard-perf-"))
    C.CACHE_DIR = folder
    return folder


def _rows(dataset, data_id, first, last):
    out = []
    d, e = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    while d <= e:
        if d.weekday() < 5:
            day = d.isoformat()
            if dataset == "TaiwanStockPrice":
                out.append({"date": day, "stock_id": data_id, "open": 10, "max": 11, "min": 9, "close": 10,
                            "Trading_Volume": 1000000, "Trading_money": 1e7, "Trading_turnover": 100})
            elif dataset == "TaiwanStockInstitutionalInvestorsBuySell":
                out += [{"date": day, "stock_id": data_id, "name": n, "buy": 2000, "sell": 1000}
                        for n in ("Foreign_Investor", "Investment_Trust", "Dealer_self")]
            elif dataset == "TaiwanStockMarginPurchaseShortSale":
                out.append({"date": day, "stock_id": data_id, "MarginPurchaseTodayBalance": 100,
                            "MarginPurchaseYesterdayBalance": 90, "ShortSaleTodayBalance": 10, "ShortSaleYesterdayBalance": 10})
        d += dt.timedelta(days=1)
    return out


def fake_finmind(latency=0.0, log=None):
    def get(url, params=None, **kw):
        if log is not None:
            log.append((params or {}).get("dataset"))
        time.sleep(latency)
        if params.get("dataset") == "TaiwanStockInfo":
            return {"status": 200, "data": [{"stock_id": params["data_id"], "stock_name": "測試", "type": "twse", "date": "2026-01-01"}]}
        return {"status": 200, "data": _rows(params["dataset"], params["data_id"], params["start_date"], params["end_date"])}
    return get


class ParallelFetchTests(unittest.TestCase):
    def test_finmind_datasets_are_fetched_concurrently(self):
        fresh_cache()
        log = []
        with patch.object(T, "http_get_json", side_effect=fake_finmind(0.25, log)), C.operation():
            t = time.time()
            raw = T.fetch_finmind("2330", "2026-06-01", "2026-06-30", "")
            elapsed = time.time() - t
        self.assertEqual(raw["name"], "測試"); self.assertEqual(raw["market"], "twse")
        self.assertTrue(raw["bars"] and raw["chips"] and raw["margin"] and raw["bench"])
        self.assertEqual(sorted(set(log)), sorted({"TaiwanStockPrice", "TaiwanStockInfo", "TaiwanStockInstitutionalInvestorsBuySell",
                                                  "TaiwanStockMarginPurchaseShortSale", "TaiwanStockDividendResult"}))
        # 六次呼叫各 0.25 秒：逐一抓要 1.5 秒以上，分兩批平行抓應在 0.5 秒左右
        self.assertLess(elapsed, 1.1, "資料集應平行抓取，實測 %.2f 秒" % elapsed)
        self.assertEqual(raw["dividend_status"], "confirmed")

    def test_dividend_status_only_reacts_to_dividend_warnings(self):
        fresh_cache()
        def get(url, params=None, **kw):
            if params.get("dataset") == "TaiwanStockMarginPurchaseShortSale":
                return None          # 融資券失敗 → 會有「融資融券：…」警示
            return fake_finmind()(url, params, **kw)
        with patch.object(T, "http_get_json", side_effect=get), C.operation() as st:
            raw = T.fetch_finmind("2330", "2026-06-01", "2026-06-30", "")
        self.assertTrue(any(w.startswith("融資融券") for w in st["warnings"]), st["warnings"])
        self.assertEqual(raw["dividend_status"], "confirmed", "別的資料集的警示不該把除權息標成 partial")

    def test_macro_series_are_fetched_concurrently(self):
        fresh_cache()
        def get(url, params=None, raw_text=False, **kw):
            time.sleep(0.25)
            if "stooq" in url:
                return "Date,Open,High,Low,Close,Volume\n2026-06-01,1,2,0.5,38000,0\n"
            ds = params.get("dataset")
            if ds == "TaiwanExchangeRate":
                return {"status": 200, "data": [{"date": "2026-06-01", "currency": "USD", "spot_buy": 31.9, "spot_sell": 32.0}]}
            if ds == "USStockPrice":
                return {"status": 200, "data": [{"date": "2026-06-01", "stock_id": params["data_id"], "Close": 100}]}
            return {"status": 200, "data": _rows("TaiwanStockPrice", params["data_id"], params["start_date"], params["end_date"])}
        with patch.object(T, "http_get_json", side_effect=get), C.operation():
            t = time.time()
            m = M.build(30, "", T.DEFAULT_ENDPOINTS)
            elapsed = time.time() - t
        self.assertEqual(len(m["series"]), 5)
        self.assertLess(elapsed, 1.0, "五個序列應同時抓，實測 %.2f 秒" % elapsed)

    def test_same_key_is_fetched_once_when_requested_concurrently(self):
        fresh_cache()
        calls = []
        def fetch(a, b):
            calls.append((a, b)); time.sleep(0.2)
            return _rows("TaiwanStockPrice", "TAIEX", a, b)
        key = C.key_for("perf", "TAIEX")
        results = []
        def go():
            with C.operation():
                results.append(len(C.range_data(key, "2026-06-01", "2026-06-30", fetch)))
        threads = [threading.Thread(target=go) for _ in range(4)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(len(calls), 1, "四個執行緒同時要同一段資料，只該向來源抓一次")
        self.assertEqual(set(results), {22})


class SettledRuleTests(unittest.TestCase):
    """1003a：近 7 日的資料在「下一次公布時間」以前都有效（時間固定為 2026-10-07 星期三，結果不受執行時刻影響）。"""
    TW = dt.timezone(dt.timedelta(hours=8))

    def setUp(self):
        fresh_cache()
        self.now = dt.datetime(2026, 10, 7, 15, 0, tzinfo=self.TW).timestamp()
        for name, value in (("clock", lambda: self.now),
                            ("today", lambda: dt.datetime.fromtimestamp(self.now, self.TW).date())):
            p = patch.object(C, name, value); p.start(); self.addCleanup(p.stop)

    def at(self, hh, mm=0, day=7):
        self.now = dt.datetime(2026, 10, day, hh, mm, tzinfo=self.TW).timestamp()

    def test_recent_days_not_reconfirmed_until_next_release(self):
        calls = []
        def fetch(a, b):
            calls.append((a, b)); return _rows("TaiwanStockPrice", "2330", a, b)
        key = C.key_for("perf-settled")
        with C.operation():
            C.range_data(key, "2026-09-15", "2026-10-07", fetch)
        self.assertEqual(len(calls), 1)
        self.at(17, 40)
        with C.operation():
            rows = C.range_data(key, "2026-09-15", "2026-10-07", fetch)
        self.assertEqual(len(calls), 1, "17:45 公布以前不該再打 API")
        self.assertTrue(rows)
        self.at(17, 50)
        with C.operation():
            C.range_data(key, "2026-09-15", "2026-10-07", fetch)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1][0], "2026-09-30", "只重新確認近 7 日")

    def test_blank_latest_day_is_reconfirmed_at_next_release(self):
        calls = []
        def fetch(a, b):
            calls.append((a, b))
            return [r for r in _rows("TaiwanStockPrice", "2330", a, b) if r["date"] != "2026-10-07"]   # 今天還沒出資料
        key = C.key_for("perf-blank")
        with C.operation():
            C.range_data(key, "2026-09-25", "2026-10-07", fetch)
        self.at(16, 30)
        with C.operation():
            C.range_data(key, "2026-09-25", "2026-10-07", fetch)
        self.assertEqual(len(calls), 1, "下一次公布（17:45）以前不重查")
        self.at(22, 0)
        with C.operation():
            C.range_data(key, "2026-09-25", "2026-10-07", fetch)
        self.assertEqual(len(calls), 2)
        self.at(7, 0, day=8)
        with C.operation():
            C.range_data(key, "2026-09-25", "2026-10-07", fetch)
        self.assertEqual(len(calls), 2, "晚上確認過，隔天 08:00 前不再查")

    def test_refresh_recent_bypasses_settled(self):
        calls = []
        def fetch(a, b):
            calls.append((a, b)); return _rows("TaiwanStockPrice", "2330", a, b)
        key = C.key_for("perf-refresh")
        with C.operation():
            C.range_data(key, "2026-09-25", "2026-10-07", fetch)
            C.range_data(key, "2026-09-25", "2026-10-07", fetch, refresh_recent=True)
        self.assertEqual(len(calls), 2)


class ServerQueueTests(unittest.TestCase):
    def setUp(self):
        fresh_cache()
        S.DEMO_MODE = True
        S._cache.clear(); S._macro_cache.clear(); S._jobs.clear()
        self.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); S.DEMO_MODE = False

    def _post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Origin": self.base})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def test_eight_jobs_submitted_at_once_all_complete(self):
        codes = ["1101", "1301", "2330", "2317", "2454", "2881", "2882", "3008"]
        ids = [self._post("/api/jobs", {"code": c, "days": 30})["job_id"] for c in codes]
        deadline = time.time() + 60
        status = {}
        while time.time() < deadline and len(status) < len(ids):
            for i in ids:
                j = self._get("/api/jobs/" + i)["job"]
                if j["status"] in ("done", "error"):
                    status[i] = j["status"]
            time.sleep(0.1)
        self.assertEqual([status.get(i) for i in ids], ["done"] * len(ids))
        self.assertGreaterEqual(S._job_pool._max_workers, 4)

    def test_queue_limit_is_generous_but_bounded(self):
        with patch.object(S, "MAX_PENDING_JOBS", 2):
            q = {"code": ["2330"], "days": ["30"]}
            with S._lock:
                S._jobs.clear()
                S._jobs["a"] = {"status": "queued", "updated": time.time()}
                S._jobs["b"] = {"status": "running", "updated": time.time()}
            with self.assertRaises(ValueError):
                S.start_job(q)


class ConnectionCapTests(unittest.TestCase):
    def test_at_most_eight_connections_at_once(self):
        peak, inflight, lock = [0], [0], threading.Lock()
        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b'{"status":200,"data":[]}'
        def urlopen(req, timeout=None, context=None):
            with lock:
                inflight[0] += 1; peak[0] = max(peak[0], inflight[0])
            time.sleep(0.15)
            with lock:
                inflight[0] -= 1
            return Resp()
        with patch.object(T.urllib.request, "urlopen", side_effect=urlopen):
            threads = [threading.Thread(target=lambda: T.http_get_json("https://example.invalid/x", {"i": 1})) for _ in range(20)]
            [t.start() for t in threads]; [t.join() for t in threads]
        self.assertGreaterEqual(peak[0], 4)
        self.assertLessEqual(peak[0], 8, "同時連線應上限 8 條，實測 %d" % peak[0])


class WarningTtlTests(unittest.TestCase):
    def test_results_with_warnings_are_cached_briefly_not_discarded(self):
        fresh_cache()
        S._cache.clear()
        calls = []
        def get(url, params=None, **kw):
            calls.append(params.get("dataset"))
            if params.get("dataset") == "TaiwanStockMarginPurchaseShortSale":
                return None
            return fake_finmind()(url, params, **kw)
        q = {"code": ["2330"], "days": ["30"], "source": ["finmind"]}
        with patch.object(T, "http_get_json", side_effect=get):
            S.get_payload(q, token_override="")
            n = len(calls)
            S.get_payload(q, token_override="")
            self.assertEqual(len(calls), n, "有警示的結果 2 分鐘內應沿用記憶體快取，不必重抓")
            entry = next(iter(S._cache.values()))
            self.assertEqual(entry["ttl"], S.WARN_TTL)
            entry["ts"] -= S.WARN_TTL + 1
            S.get_payload(q, token_override="")
            self.assertGreater(len(calls), n, "短快取過期後應重試缺漏的資料集")


if __name__ == "__main__":
    unittest.main()
