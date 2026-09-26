# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""20260925a 全市場掃描：來源解析（新舊格式）、逐日快取、節流、指標、選股清單、族群象限、警示、模擬持倉、API。"""
import datetime as dt
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-mk-"))
os.environ["TWBOARD_DATA_DIR"] = tempfile.mkdtemp(prefix="twboard-mk-data-")
import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twmarket as MK         # noqa: E402
import twserve as S           # noqa: E402

MK.INTERVAL = {}              # 測試不等待


def fresh():
    C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-mk-"))
    os.environ["TWBOARD_DATA_DIR"] = tempfile.mkdtemp(prefix="twboard-mk-data-")
    MK._tpex_pref.update(quotes=0, insti=0)


RED, GREEN, BLANK = "<p style= color:red>+</p>", "<p style= color:green>-</p>", "<p> </p>"
TWSE_FIELDS = ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價",
               "漲跌(+/-)", "漲跌價差", "最後揭示買價", "最後揭示買量", "最後揭示賣價", "最後揭示賣量", "本益比"]


def twse_row(code, name, close, sign, diff, vol=1_000_000):
    return [code, name, "{:,}".format(vol), "1,234", "{:,}".format(int(vol * close)), "%.2f" % close,
            "%.2f" % (close * 1.01), "%.2f" % (close * .99), "{:,.2f}".format(close), sign, "%.2f" % diff, "", "", "", "", ""]


def mi_index(day, rows, legacy=False):
    table = {"title": "每日收盤行情(全部(不含權證、牛熊證))", "fields": TWSE_FIELDS, "data": rows}
    if legacy:
        return {"stat": "OK", "date": day.replace("-", ""), "fields9": TWSE_FIELDS, "data9": rows}
    return {"stat": "OK", "date": day.replace("-", ""),
            "tables": [{"title": "價格指數", "fields": ["指數", "收盤指數"], "data": [["加權", "23,000"]]}, table]}


TPEX_FIELDS = ["代號", "名稱", "收盤", "漲跌", "開盤", "最高", "最低", "均價", "成交股數", "成交金額(元)", "成交筆數",
               "最後買價", "最後買量(張數)", "最後賣價", "最後賣量(張數)", "發行股數", "次日漲停價", "次日跌停價"]


def tpex_row(code, name, close, chg, vol=500_000):
    return [code, name, "%.2f" % close, ("%+.2f" % chg) if chg else "0.00", "%.2f" % close, "%.2f" % (close * 1.02),
            "%.2f" % (close * .98), "%.2f" % close, "{:,}".format(vol), "{:,}".format(int(vol * close)), "800",
            "", "", "", "", "", "", ""]


class ParserTests(unittest.TestCase):
    def test_twse_modern_and_legacy_tables(self):
        rows = [twse_row("2330", "台積電", 1005, RED, 15), twse_row("2303", "聯電", 49.5, GREEN, .5),
                twse_row("1101", "台泥", 30, BLANK, 0), ["9999", "停牌", "0", "0", "0", "--", "--", "--", "--", BLANK, "0.00"]]
        for legacy in (False, True):
            got = MK.parse_twse_quotes(mi_index("2026-09-24", rows, legacy))
            self.assertEqual(got["2330"][:4], [1005.0, 1015.05, 994.95, 1005.0])
            self.assertEqual(got["2330"][4], 1000.0, "股 → 張")
            self.assertEqual(got["2330"][7], 15.0); self.assertEqual(got["2303"][7], -0.5); self.assertEqual(got["1101"][7], 0.0)
            self.assertIsNone(got["9999"][3], "沒成交的收盤是 None，不是 0")
            self.assertEqual(got["2330"][8], "台積電")

    def test_twse_closed_and_broken(self):
        self.assertEqual(MK.parse_twse_quotes({"stat": "很抱歉，沒有符合條件的資料!"}), {})
        with self.assertRaises(MK.FormatError):
            MK.parse_twse_quotes({"stat": "OK", "tables": [{"fields": ["別的"], "data": []}]})
        with self.assertRaises(MK.FormatError):
            MK.parse_twse_quotes({"stat": "查詢頻率過高"} if False else {"stat": "ERROR"})

    def test_tpex_new_old_and_empty(self):
        new = {"date": "20260924", "stat": "ok", "tables": [{"date": "20260924", "fields": TPEX_FIELDS,
               "data": [tpex_row("6488", "環球晶", 500, 10), tpex_row("5347", "世界", 100, -2)]}]}
        old = {"reportDate": "115/09/24", "iTotalRecords": 2,
               "aaData": [tpex_row("6488", "環球晶", 500, 10), tpex_row("5347", "世界", 100, -2)]}
        for j in (new, old):
            got = MK.parse_tpex_quotes(j)
            self.assertEqual(got["6488"][3], 500.0); self.assertEqual(got["6488"][7], 10.0); self.assertEqual(got["5347"][7], -2.0)
            self.assertEqual(got["6488"][4], 500.0); self.assertEqual(got["6488"][8], "環球晶")
            self.assertEqual(MK._response_date(j), "2026-09-24")
        self.assertEqual(MK.parse_tpex_quotes({"aaData": [], "iTotalRecords": 0}), {})
        self.assertEqual(MK.parse_tpex_quotes({"tables": [{"fields": TPEX_FIELDS, "data": []}]}), {})
        with self.assertRaises(MK.FormatError):
            MK.parse_tpex_quotes({"message": "維護中"})

    def test_tpex_insti_positional_and_named(self):
        row = ["6488", "環球晶"] + [str(x * 1000) for x in range(1, 22)] + ["-5,000"]
        got = MK.parse_tpex_insti({"aaData": [row]})["6488"]
        self.assertEqual(got, [9.0, 12.0, 21.0, -5.0])       # 外資合計、投信、自營商合計、三大法人（張）
        fields = ["代號", "名稱", "外資及陸資(不含外資自營商)-買賣超股數", "外資自營商-買賣超股數", "外資及陸資-買賣超股數",
                  "投信-買賣超股數", "自營商(自行買賣)-買賣超股數", "自營商(避險)-買賣超股數", "自營商-買賣超股數", "三大法人買賣超股數合計"]
        got = MK.parse_tpex_insti({"tables": [{"fields": fields, "data": [["6488", "x", "1000", "2000", "3000", "4000", "5000", "6000", "11000", "18000"]]}]})
        self.assertEqual(got["6488"], [3.0, 4.0, 11.0, 18.0])

    def test_themes_validation(self):
        ok = MK.normalize_themes([{"name": "AI", "codes": "2330, 2317，2382 2330"}])
        self.assertEqual(ok, [{"name": "AI", "codes": ["2330", "2317", "2382"]}])
        for bad in ([{"name": "", "codes": ["2330", "2317"]}], [{"name": "A", "codes": ["2330"]}],
                    [{"name": "A", "codes": ["2330", "abc"]}], [{"name": "A", "codes": ["2330", "2317"]}] * 2):
            with self.assertRaises(ValueError):
                MK.normalize_themes(bad)
        for t in MK.DEFAULT_THEMES:          # 預設族群本身要通過驗證
            MK.normalize_themes([t])


def series(closes, vols=None):
    vols = vols or [1000] * len(closes)
    return [None if c is None else [c, c * 1.01, c * .99, c, v, v * 1000 * c, 10, None, "x"] for c, v in zip(closes, vols)]


class MetricTests(unittest.TestCase):
    def test_returns_ma_cross_high_and_volume(self):
        closes = [100.0] * 58 + [95.0, 99.0, 110.0]            # 61 天，最後一天放量上漲突破
        vols = [1000] * 60 + [3000]
        dates = ["d%02d" % i for i in range(61)]
        m = MK.stock_metrics("2330", "上市", dates, series(closes, vols), {}, {})
        self.assertAlmostEqual(m["r5"], 10.0); self.assertAlmostEqual(m["r20"], 10.0); self.assertAlmostEqual(m["r60"], 10.0)
        self.assertAlmostEqual(m["chg_pct"], (110 / 99 - 1) * 100, places=2)
        self.assertAlmostEqual(m["vratio"], 3000 / ((1000 * 19 + 3000) / 20), places=2)
        self.assertTrue(m["cross20"] and m["above20"] and m["new_high60"] and m["high20_break"])
        self.assertIn("爆量", MK.tags(m)); self.assertIn("站上月線", MK.tags(m)); self.assertIn("60日新高", MK.tags(m))

    def test_missing_day_uses_previous_trade_and_exchange_change(self):
        closes = [100.0] * 15 + [None] + [100.0] * 4 + [None, 105.0]      # 停牌兩天
        s = series(closes)
        s[-1][7] = 5.0                                                     # 交易所漲跌（對參考價）
        m = MK.stock_metrics("1101", "上市", ["d"] * len(closes), s, {}, {})
        self.assertAlmostEqual(m["chg_pct"], 5.0, places=2)
        self.assertAlmostEqual(m["r5"], 5.0, places=2)
        self.assertIsNone(MK.stock_metrics("1101", "上市", ["d"] * 3, series([1, 2, None]), {}, {}), "今天沒成交就不列")

    def test_chip_streaks(self):
        chips = {"2026-09-%02d" % d: {"2330": [1, 1, 1, v]} for d, v in zip(range(10, 16), [-5, 3, 4, 2, 6, 1])}
        m = MK.stock_metrics("2330", "上市", ["d"] * 30, series([100.0] * 30), chips, {})
        self.assertEqual(m["streak"], 5); self.assertEqual(m["net5"], 16); self.assertEqual(m["chip_date"], "2026-09-15")
        chips["2026-09-16"] = {"2330": [1, -2, 0, -3]}
        m = MK.stock_metrics("2330", "上市", ["d"] * 30, series([100.0] * 30), chips, {})
        self.assertEqual(m["streak"], -1); self.assertEqual(m["trust_streak"], -1)

    def test_quadrants_and_sector_average(self):
        self.assertEqual([MK.quadrant(1, 1), MK.quadrant(1, -1), MK.quadrant(-1, 1), MK.quadrant(-1, -1)], ["領漲", "轉強", "轉弱", "落後"])
        by = {c: {"code": c, "name": c, "r5": r5, "r20": r20, "r60": None, "vol20": 30.0, "amount20": amt, "chg_pct": 1.0}
              for c, r5, r20, amt in [("1", 2, 4, 1e9), ("2", 4, 8, 5e8), ("3", 6, 12, 1e8), ("4", -90, -90, 1e5)]}
        g = MK.sector_table([("測試", "概念", ["1", "2", "3", "4", "9999"])], by, 3e7)[0]
        self.assertEqual((g["r5"], g["r20"], g["count"]), (4.0, 8.0, 3), "不活躍的成員不拉低平均")
        self.assertEqual(g["quadrant"], "領漲"); self.assertEqual(g["leaders"][0]["code"], "1"); self.assertEqual(g["missing"], ["9999"])
        self.assertEqual(MK.sector_table([("少", "概念", ["1", "2"])], by, 3e7), [], "少於 3 檔不算")

    def test_scan_score_range_and_chip_reweight(self):
        raw = MK.demo_raw(61)
        res = MK.analyse(raw, MK.DEFAULT_THEMES)
        scores = [s["scan_score"] for s in res["stocks"] if s["scan_score"] is not None]
        self.assertTrue(scores and all(0 <= v <= 100 for v in scores))
        strong = [next(s for s in res["stocks"] if s["code"] == c)["scan_score"] for c in res["screens"]["strong"]]
        self.assertEqual(strong, sorted(strong, reverse=True))
        self.assertTrue(all(next(s for s in res["stocks"] if s["code"] == c)["kind"] == "stock" for l in res["screens"].values() for c in l),
                        "選股清單只放一般股票，不放 ETF")
        # 沒有法人資料時，綜合強勢分仍是 0～100（籌碼 15 分改由其他項目分攤）
        for d in raw["twse_chips"].values():
            d.clear()
        for d in raw["tpex_chips"].values():
            d.clear()
        res2 = MK.analyse(raw, MK.DEFAULT_THEMES)
        self.assertTrue(all(0 <= s["scan_score"] <= 100 for s in res2["stocks"] if s["scan_score"] is not None))
        self.assertEqual(res2["screens"]["inst"], [])
        quads = {g["quadrant"] for g in res["sectors"]}
        self.assertTrue(quads <= {"領漲", "轉強", "轉弱", "落後"})
        self.assertTrue(any(g["kind"] == "產業" for g in res["sectors"]) and any(g["kind"] == "概念" for g in res["sectors"]))


class CollectTests(unittest.TestCase):
    """模擬證交所、櫃買、FinMind：休市要記住、過去的日子不重抓、櫃買新版格式壞掉要改用舊版並留紀錄。"""
    def setUp(self):
        fresh()
        self.calls = []
        self.holiday = None
        days = [d for d in MK._weekdays_back(20)]
        self.holiday = days[3].isoformat()

    def fake(self, url, params=None, raw_text=False, **kw):
        out = self._fake(url, params, **kw)
        if raw_text and isinstance(out, dict):
            return json.dumps(out)          # 真的 http_get_json(raw_text=True) 回傳字串
        if not raw_text and isinstance(out, str):
            return json.loads(out)
        return out

    def _fake(self, url, params=None, **kw):
        self.calls.append((url, dict(params or {})))
        if "finmind" in url:
            return {"status": 200, "data": [{"stock_id": "2330", "stock_name": "台積電", "industry_category": "電子工業", "type": "twse"},
                                            {"stock_id": "2330", "stock_name": "台積電", "industry_category": "半導體業", "type": "twse"},
                                            {"stock_id": "6488", "stock_name": "環球晶", "industry_category": "半導體業", "type": "tpex"}]}
        if "MI_INDEX" in url:
            day = "%s-%s-%s" % (params["date"][:4], params["date"][4:6], params["date"][6:])
            if day == self.holiday:
                return json.dumps({"stat": "很抱歉，沒有符合條件的資料!"})
            n = dt.date.fromisoformat(day).toordinal() % 50
            rows = [twse_row(c, c, 100 + n + i, RED, 1) for i, c in enumerate(["2330", "2317", "2454", "0050", "2881A"])]
            return json.dumps(mi_index(day, rows))
        if "T86" in url:
            return {"stat": "OK", "fields": ["證券代號", "證券名稱"] + ["x"] * 17,
                    "data": [["2330", "台積電"] + ["1,000"] * 16 + ["3,000"]]}
        if "dailyQuotes" in url or "dailyTrade" in url:
            return "<html>系統維護中</html>"                         # 新版網址壞掉
        if "stk_quote_result" in url:
            d = T.roc_to_iso(params["d"])
            if d == self.holiday:
                return json.dumps({"aaData": [], "iTotalRecords": 0})
            return json.dumps({"reportDate": params["d"], "aaData": [tpex_row("6488", "環球晶", 500, 5), tpex_row("5347", "世界", 90, 1),
                                                                     tpex_row("3105", "穩懋", 200, -1)]})
        if "3itrade" in url:
            return json.dumps({"aaData": [["6488", "環球晶"] + ["1000"] * 21 + ["2000"]]})
        raise AssertionError(url)

    def test_collect_cache_holiday_fallback_and_debug_log(self):
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation() as st:
            raw = MK.collect(8, token="tok")
        self.assertEqual(len(raw["twse"]), 8); self.assertEqual(len(raw["tpex"]), 8)
        self.assertNotIn(self.holiday, raw["twse"])
        self.assertEqual(raw["info"]["2330"]["industry"], "半導體業", "避開「電子工業」這種大分類")
        self.assertEqual(len(raw["twse_chips"]), 8); self.assertEqual(raw["tpex_chips"][max(raw["tpex_chips"])]["6488"][3], 2.0)
        new_hits = [c for c in self.calls if "dailyQuotes" in c[0]]
        self.assertEqual(len(new_hits), 1, "新版網址失敗一次後，本次改走舊版，不再每天先試")
        log = Path(MK.data_path("market_debug.log")).read_text(encoding="utf-8")
        self.assertIn("系統維護中", log); self.assertNotIn("tok", log)
        self.assertEqual(st["warnings"], [])
        # 第二次：過去的日子全部走快取；只有「今天」可能再確認
        self.calls.clear()
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation() as st2:
            raw2 = MK.collect(8, token="tok")
        today = C.today().isoformat()
        refetched = [c for c in self.calls if "MI_INDEX" in c[0] and c[1]["date"] != today.replace("-", "")]
        self.assertEqual(refetched, [], "過去的交易日與休市日不該重抓")
        self.assertEqual(raw2["twse"], raw["twse"])
        # 只用快取（頁面載入時）：完全不連網
        self.calls.clear()
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation():
            raw3 = MK.collect(8, allow_network=False)
        self.assertEqual(self.calls, []); self.assertEqual(sorted(raw3["twse"]), sorted(raw["twse"]))
        res = MK.analyse(raw, MK.DEFAULT_THEMES, 0)
        codes = {s["code"] for s in res["stocks"]}
        self.assertTrue({"2330", "2317", "0050", "6488"} <= codes); self.assertNotIn("2881A", codes, "特別股不列")
        self.assertEqual(next(s for s in res["stocks"] if s["code"] == "6488")["market"], "上櫃")

    def test_failed_day_is_not_cached_as_closed(self):
        def broken(url, params=None, raw_text=False, **kw):
            if "MI_INDEX" in url:
                return None                                        # 連線失敗
            return self.fake(url, params, raw_text, **kw)
        with patch.object(T, "http_get_json", side_effect=broken), C.operation() as st:
            raw = MK.collect(5)
        self.assertEqual(raw["twse"], {})
        self.assertTrue(any("上市行情" in w for w in st["warnings"]))
        with patch.object(T, "http_get_json", side_effect=self.fake), C.operation():
            raw = MK.collect(5)
        self.assertEqual(len(raw["twse"]), 5, "失敗的日子下次要重抓，不能當成休市")

    def test_throttle_spaces_requests_per_host(self):
        MK.INTERVAL = {"a.example": 0.2}
        MK._last_hit.clear()
        try:
            t = time.monotonic()
            for _ in range(4):
                MK._wait("https://a.example/x")
            MK._wait("https://b.example/x")
            self.assertGreaterEqual(time.monotonic() - t, 0.55)
        finally:
            MK.INTERVAL = {}


class AlertPortfolioTests(unittest.TestCase):
    def setUp(self):
        fresh()

    def test_alerts(self):
        MK.save_alert("2330", above="1000", below="900", pct="5")
        with self.assertRaises(ValueError):
            MK.save_alert("2330", above="900", below="1000")
        with self.assertRaises(ValueError):
            MK.save_alert("2330")
        q = {"date": "2026-09-24", "close": 990, "high": 1001, "low": 950, "chg_pct": 1.2}
        a = MK.evaluate_alerts(MK.load_alerts(), lambda c: q)[0]
        self.assertTrue(a["triggered"] and a["new"]); self.assertEqual(len(a["hits"]), 1); self.assertIn("上限", a["hits"][0])
        MK.ack_alerts("2026-09-24")
        a = MK.evaluate_alerts(MK.load_alerts(), lambda c: q)[0]
        self.assertTrue(a["triggered"]); self.assertFalse(a["new"], "確認過就不再算新警示")
        a = MK.evaluate_alerts(MK.load_alerts(), lambda c: None)[0]
        self.assertFalse(a["triggered"])
        MK.delete_alert("2330"); self.assertEqual(MK.load_alerts(), [])

    def test_portfolio_math(self):
        pf = MK.paper_buy("2330", "100", "1", "2026-09-01", "台積電")
        pos = pf["open"][0]
        self.assertEqual(MK.pnl(pos, 110), {"cost": 100142, "value": 109513, "profit": 9371, "return_pct": 9.36})
        self.assertEqual(MK._tax("0050"), 0.1)
        view = MK.portfolio_view(pf, lambda c: {"date": "2026-09-24", "close": 110})
        self.assertEqual(view["summary"]["unrealized"], 9371); self.assertEqual(view["open"][0]["days"], 23)
        with self.assertRaises(ValueError):
            MK.paper_sell(pos["id"], "110", "2026-08-01")
        pf = MK.paper_sell(pos["id"], "110", "2026-09-24")
        self.assertEqual(pf["open"], []); self.assertEqual(pf["closed"][0]["profit"], 9371)
        for bad in (("2330", "0", "1"), ("2330", "100", "0.0005"), ("2330", "abc", "1")):
            with self.assertRaises(ValueError):
                MK.paper_buy(*bad)
        with self.assertRaises(ValueError):
            MK.paper_buy("2330", "100", "1", (C.today() + dt.timedelta(days=3)).isoformat())

    def test_corrupt_files_are_not_overwritten(self):
        Path(MK.data_path("alerts.json")).write_text("{broken", encoding="utf-8")
        with self.assertRaises(ValueError):
            MK.save_alert("2330", above="1")
        self.assertEqual(Path(MK.data_path("alerts.json")).read_text(encoding="utf-8"), "{broken")


class ServerTests(unittest.TestCase):
    def setUp(self):
        fresh()
        S.DEMO_MODE = True
        S._market.update(raw=None, results={}, job=None, by={})
        self.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); S.DEMO_MODE = False

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Origin": self.base})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    def test_scan_job_then_views(self):
        self.assertIsNone(self.get("/api/market")["data"])
        self.assertIn("最低成交值", self.get("/api/market?min_amount=5")["error"])
        job = self.post("/api/market/scan", {"days": "60", "min_amount": "30000000"})["job_id"]
        self.assertEqual(self.post("/api/market/scan", {"days": "60"})["job_id"], job, "掃描中再按一次，沿用同一個工作")
        for _ in range(100):
            j = self.get("/api/jobs/" + job)["job"]
            if j["status"] in ("done", "error"):
                break
            time.sleep(0.05)
        self.assertEqual(j["status"], "done", j.get("error"))
        data = j["data"]
        self.assertTrue(data["stocks"] and data["sectors"] and data["screens"]["strong"])
        self.assertEqual(self.get("/api/market?min_amount=0")["data"]["min_amount"], 0)
        self.assertIn("20 或 60", self.post("/api/market/scan", {"days": "30"})["error"])
        code = data["screens"]["strong"][0]
        close = next(s for s in data["stocks"] if s["code"] == code)["close"]
        # 警示用市場掃描的最新價
        r = self.post("/api/alerts", {"code": code, "above": str(close * 0.5)})
        self.assertTrue(r["alerts"][0]["triggered"]); self.assertEqual(r["alerts"][0]["quote"]["source"], "市場掃描")
        self.assertIn("下限價要低於上限價", self.post("/api/alerts", {"code": code, "above": "10", "below": "20"})["error"])
        # 模擬持倉
        r = self.post("/api/portfolio/buy", {"code": code, "price": str(close), "lots": "2"})
        self.assertEqual(r["portfolio"]["summary"]["positions"], 1)
        self.assertLess(r["portfolio"]["open"][0]["profit"], 0, "同價買進，扣掉手續費與稅是小虧")
        pid = r["portfolio"]["open"][0]["id"]
        r = self.post("/api/portfolio/sell", {"id": pid, "price": str(close * 1.1)})
        self.assertEqual(r["portfolio"]["summary"]["positions"], 0); self.assertGreater(r["portfolio"]["summary"]["realized"], 0)
        # 概念族群：儲存後重算
        r = self.post("/api/themes", {"themes": json.dumps([{"name": "我的族群", "codes": [code, "2330", "2317"]}])})
        self.assertTrue(r["custom"])
        names = [g["name"] for g in self.get("/api/market")["data"]["sectors"] if g["kind"] == "概念"]
        self.assertEqual(names, ["我的族群"])
        self.assertIn("請放 2", self.post("/api/themes", {"themes": json.dumps([{"name": "x", "codes": ["2330"]}])})["error"])
        r = self.post("/api/themes/reset", {})
        self.assertFalse(r["custom"]); self.assertEqual(len(r["themes"]), len(MK.DEFAULT_THEMES))

    def test_cross_origin_blocked(self):
        req = urllib.request.Request(self.base + "/api/portfolio/buy", data=b'{"code":"2330","price":"1"}',
                                     headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(e.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
