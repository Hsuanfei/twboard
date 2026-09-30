# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""0930b 強力分析：九個分頁的計算、FinMind／集保欄位解析、快取與 /api/power。"""
import datetime as dt
import json
import math
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-pw-"))
os.environ.setdefault("TWBOARD_DATA_DIR", tempfile.mkdtemp(prefix="twboard-pw-data-"))
import twboard as T          # noqa: E402
import twcache as TC         # noqa: E402
import twpower as P          # noqa: E402
import twserve as S          # noqa: E402


def fresh_cache():
    folder = Path(tempfile.mkdtemp(prefix="twboard-pw-"))
    TC.CACHE_DIR = folder
    return folder


def trading_days(start, n):
    d, out = dt.date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def make_bars(closes, start="2025-01-02", vol=1000.0):
    days = trading_days(start, len(closes))
    return [{"date": d, "open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "vol": vol} for d, c in zip(days, closes)]


class ReturnsAndRiskTests(unittest.TestCase):
    def test_ex_dividend_day_uses_reference_price(self):
        bars = make_bars([100, 100, 95, 96])
        rets = P.daily_returns(bars, [{"date": bars[2]["date"], "before": 100, "amount": 5, "after": 95}])
        self.assertAlmostEqual(rets[1][1], 0.0, msg="除息日以參考價計算，不算下跌")
        self.assertAlmostEqual(rets[2][1], 96 / 95 - 1)
        # 沒有參考價時用「除息前價 − 權息值」；不合理的參考價不採用
        self.assertAlmostEqual(P.daily_returns(bars, [{"date": bars[2]["date"], "before": 100, "amount": 5}])[1][1], 0.0)
        self.assertAlmostEqual(P.daily_returns(bars, [{"date": bars[2]["date"], "before": 100, "after": 130}])[1][1], -0.05)

    def test_risk_metrics(self):
        closes, px = [], 100.0
        for i in range(300):
            px *= 1.012 if i % 3 else 0.985
            closes.append(round(px, 4))
        bars = make_bars(closes)
        bench = {b["date"]: b["close"] ** 0.5 * 10 for b in bars}     # 同方向、較小波動 → β 約 2
        r = P.risk(bars, [], bench, issued_shares=1e8)
        self.assertTrue(r["available"])
        self.assertEqual(r["days"], 250)
        rs = [x for _, x in P.daily_returns(bars)][-250:]
        mu = sum(rs) / len(rs)
        sd = math.sqrt(sum((x - mu) ** 2 for x in rs) / (len(rs) - 1))
        self.assertAlmostEqual(r["volatility"], round(sd * math.sqrt(252) * 100, 1))
        self.assertAlmostEqual(r["sharpe"], round((mu * 252 - 0.015) / (sd * math.sqrt(252)), 2))
        self.assertAlmostEqual(r["beta"], 2.0, delta=0.05)
        self.assertAlmostEqual(r["correlation"], 1.0, delta=0.01)
        self.assertEqual(r["var95"], round(-1.5, 2))
        self.assertEqual(r["cvar95"], -1.5)
        self.assertLess(r["max_drawdown"], 0)
        self.assertAlmostEqual(r["turnover"], 1000 * 1000 / 1e8 * 100, places=2)
        self.assertEqual(len(r["chart"]["date"]), 251)
        self.assertEqual(r["chart"]["drawdown"][0], 0)
        self.assertIn(r["headline"]["label"], ("高風險", "中風險", "低風險"))
        self.assertFalse(P.risk(make_bars([100] * 30))["available"])


class SplitTests(unittest.TestCase):
    def test_split_adjustment(self):
        # 第 4 根一拆四（188 → 47），之後又漲回 50；第 2 根除息
        bars = make_bars([180, 188, 186, 188, 47, 48, 50])
        divs = [{"date": bars[2]["date"], "kind": "除息", "amount": 4.0, "before": 188.0, "after": 184.0}]
        adj, adivs, sp = P.adjust_for_splits(bars, divs)
        self.assertEqual(sp, [{"date": bars[4]["date"], "ratio": 4.0}])
        self.assertEqual([round(b["close"], 2) for b in adj], [45, 47, 46.5, 47, 47, 48, 50])
        self.assertEqual(adj[0]["vol"], 4000.0, "分割前的成交量換算成新股數")
        self.assertEqual((adivs[0]["before"], adivs[0]["amount"], adivs[0]["after"]), (47.0, 1.0, 46.0))
        self.assertEqual((adivs[0]["orig_before"], adivs[0]["orig_amount"]), (188.0, 4.0))
        rets = dict(P.daily_returns(adj, adivs))
        self.assertAlmostEqual(rets[bars[4]["date"]], 0.0, msg="分割日不算漲跌")
        f = P.dividend_fill(adj, adivs)
        self.assertTrue(f["rows"][0]["filled"]); self.assertEqual(f["rows"][0]["days"], 1)
        self.assertEqual(f["rows"][0]["before"], 188.0, "表格顯示當時的原始價格")
        # 沒有分割時原封不動
        same, sd, none = P.adjust_for_splits(bars[:4], divs)
        self.assertEqual(none, []); self.assertEqual(same, bars[:4])


class USLinkTests(unittest.TestCase):
    def test_next_day_pairing_and_holiday_compounding(self):
        tw = [("2026-01-05", 0.01), ("2026-01-06", 0.02), ("2026-01-09", -0.01)]      # 7、8 日台股休市
        us = [("2026-01-02", 100), ("2026-01-05", 101), ("2026-01-06", 102), ("2026-01-07", 103), ("2026-01-08", 104)]
        nxt, same, _ = P.us_pairs(tw, us)
        # 台股 1/6 ← 美股 1/5（前一個台股交易日當晚）；台股 1/9 ← 美股 1/6～1/8 連乘
        self.assertEqual([p[2] for p in nxt], ["2026-01-06", "2026-01-09"])
        self.assertAlmostEqual(nxt[0][0], 101 / 100 - 1)
        self.assertAlmostEqual(nxt[1][0], 104 / 101 - 1)
        self.assertEqual([p[2] for p in same], ["2026-01-05", "2026-01-06"])

    def test_us_link_stats(self):
        days = trading_days("2025-06-02", 260)
        import random
        rnd = random.Random(1)
        us_ret = [rnd.gauss(0, 0.015) for _ in days]
        tw = [(days[0], 0.0)] + [(days[i], 0.5 * us_ret[i - 1] + rnd.gauss(0, 0.004)) for i in range(1, len(days))]
        px, closes = 100.0, []
        for d, r in zip(days, us_ret):
            px *= 1 + r
            closes.append((d, px))
        out = P.us_link(tw, {"^SOX": {"rows": closes, "source": "t"}, "AAPL": {"rows": [], "reason": "取不到"}},
                        [("^SOX", "費城半導體"), ("AAPL", "蘋果")])
        self.assertTrue(out["available"])
        sox = out["rows"][0]
        self.assertGreater(sox["corr_next"], 0.8)
        self.assertEqual(sox["strength"], "強")
        self.assertAlmostEqual(sox["beta"], 0.5, delta=0.05)
        self.assertGreater(sox["same_dir"], 80)
        self.assertEqual(len(sox["scatter"]), sox["n"])
        self.assertFalse(out["rows"][1]["available"])
        self.assertEqual(out["best"], "^SOX")
        self.assertIn("費城半導體", out["headline"]["text"])

    def test_clean_us(self):
        self.assertEqual(P.clean_us("mu, avgo；^SOX, bad!!, TSLA, QQQ, SMH, x"), ["MU", "TSLA", "QQQ", "SMH"])


class ProfileAndChipTests(unittest.TestCase):
    def test_volume_profile(self):
        closes = [100] * 50 + [110] * 10
        bars = make_bars(closes)
        for b in bars[:50]:
            b["vol"] = 5000.0
        vp = P.volume_profile(bars, windows=(60,), bins=20)
        w = vp["windows"]["60"]
        self.assertTrue(99 <= w["poc"] <= 101, w["poc"])
        self.assertGreaterEqual(w["value_pct"], 70)
        self.assertEqual(w["where"], "above")
        self.assertAlmostEqual(sum(x["pct"] for x in w["levels"]), 100, delta=0.2)

    def test_foreign(self):
        bars = make_bars([100 + i * 0.1 for i in range(80)])
        rows = [{"date": b["date"], "ratio": 30 - i * 0.03, "limit": 100.0, "remain": 70 + i * 0.03,
                 "shares": 1000.0, "issued": 5000.0} for i, b in enumerate(bars)]
        f = P.foreign(rows, bars)
        self.assertAlmostEqual(f["ch20"], -0.6)
        self.assertEqual(f["streak"], -79)
        self.assertEqual(f["room"], "外資還有加碼空間")
        rows[-1]["ratio"] = rows[-21]["ratio"] - 1.2
        self.assertEqual(P.foreign(rows, bars)["headline"]["tone"], "down")
        self.assertFalse(P.foreign([], bars)["available"])

    def test_short_and_daytrade(self):
        bars = make_bars([100] * 60, vol=2000.0)
        margin = {b["date"]: {"short_bal": 300.0} for b in bars}
        bal = [{"date": b["date"], "sbl": (4000 + (i >= 45) * 1500) * 1000.0, "margin_short": 300000.0} for i, b in enumerate(bars)]
        dtd = [{"date": b["date"], "volume": 900.0} for b in bars]
        out = P.short_daytrade(bal, margin, dtd, bars)
        self.assertEqual(P.sbl_unit(bal, margin), 1000.0, "融券 300 張 ↔ 300,000 → 單位是股")
        s = out["sbl"]
        self.assertEqual(s["balance"], 5500)
        self.assertEqual(s["ch20"], 1500)
        self.assertEqual(s["days_to_cover"], 2.8)
        self.assertEqual(s["margin_short"], 300)
        self.assertEqual(out["headline"]["tone"], "down")
        t = out["daytrade"]
        self.assertEqual(t["latest"], 45.0)
        self.assertTrue(t["hot"])
        # 單位已經是張時不再除 1000
        self.assertEqual(P.sbl_unit([dict(r, margin_short=300.0) for r in bal], margin), 1.0)


class FundamentalTests(unittest.TestCase):
    def rows(self):
        stmt, cash = [], []
        cum = {}
        for i, d in enumerate(["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]):
            rev = 1000.0 + i * 100
            stmt += [{"date": d, "type": "Revenue", "value": rev, "origin_name": "營業收入合計"},
                     {"date": d, "type": "GrossProfit", "value": rev * 0.3, "origin_name": "營業毛利（毛損）淨額"},
                     {"date": d, "type": "OperatingIncome", "value": rev * (0.1 + i * 0.01), "origin_name": "營業利益（損失）"},
                     {"date": d, "type": "IncomeAfterTaxes", "value": 80.0, "origin_name": "本期淨利（淨損）"},
                     {"date": d, "type": "EPS", "value": 1.0 + i * 0.1, "origin_name": "基本每股盈餘（元）"}]
            y = d[:4]
            c = cum.setdefault(y, [0.0, 0.0])
            c[0] += 100.0; c[1] -= 30.0
            cash += [{"date": d, "type": "CashFlowsFromOperatingActivities", "value": c[0], "origin_name": "營業活動之淨現金流入（流出）"},
                     {"date": d, "type": "PropertyAndPlantAndEquipment", "value": c[1], "origin_name": "取得不動產、廠房及設備"}]
        return stmt, cash

    def test_cumulative_cash_flow_to_quarters(self):
        q = P.statements_by_quarter(*self.rows())
        self.assertEqual([x["q"] for x in q], ["25Q1", "25Q2", "25Q3", "25Q4", "26Q1", "26Q2"])
        self.assertEqual([x["cfo"] for x in q], [100.0] * 6, "年初累計換算成單季")
        self.assertEqual([x["capex"] for x in q], [-30.0] * 6)

    def test_margins(self):
        m = P.margins(P.statements_by_quarter(*self.rows()))
        self.assertEqual(m["gm"], 30.0)
        self.assertEqual(m["latest"], "26Q2")
        self.assertAlmostEqual(m["om_qoq"], 1.0)
        self.assertAlmostEqual(m["om_yoy"], 4.0)
        self.assertEqual(m["eps4"], round(1.2 + 1.3 + 1.4 + 1.5, 2))
        self.assertEqual(m["quality"], 1.25)
        self.assertEqual(m["fcf4"], 400 - 120)
        self.assertEqual(m["headline"]["tone"], "good")
        self.assertEqual(len(m["chart"]["q"]), 6)
        self.assertFalse(P.margins([])["available"])

    def test_origin_name_fallback(self):
        stmt = [{"date": "2026-06-30", "type": "X", "value": 500, "origin_name": "營業收入合計"},
                {"date": "2026-06-30", "type": "Y", "value": 100, "origin_name": "營業毛利（毛損）淨額"}]
        q = P.statements_by_quarter(stmt, [])
        self.assertEqual((q[0]["revenue"], q[0]["gross"]), (500.0, 100.0))


class DividendAndSeasonTests(unittest.TestCase):
    def test_fill(self):
        closes = [100, 96, 97, 101, 99] + [99] * 70 + [120, 118, 119]
        bars = make_bars(closes)
        divs = [{"date": bars[1]["date"], "kind": "除息", "amount": 4.0, "before": 100.0},
                {"date": bars[76]["date"], "kind": "除權息", "amount": 3.0, "before": 125.0}]
        f = P.dividend_fill(bars, divs)
        first, last = f["rows"][1], f["rows"][0]
        self.assertTrue(first["filled"]); self.assertEqual(first["days"], 2); self.assertEqual(first["fill_date"], bars[3]["date"])
        self.assertFalse(last["filled"]); self.assertEqual(last["elapsed"], 1)
        self.assertAlmostEqual(last["gap"], round((125 / 119 - 1) * 100, 2))
        self.assertIn("尚未填息", f["headline"]["text"])
        self.assertEqual((f["same_day"], f["same_n"]), (0, 2))
        self.assertEqual((f["within20"], f["n20"]), (100, 1), "未滿 20 天的那次不算進分母")
        self.assertEqual(f["avg_yield"], 4.0, "平均殖利率只算除息")
        self.assertFalse(P.dividend_fill(bars, [])["available"])

    def test_seasonality(self):
        days = [d for d in trading_days("2023-01-02", 900) if d < "2026-06-15"]
        closes, px = [], 100.0
        for d in days:
            px *= 1.003 if d[5:7] == "04" else 0.999
            closes.append(px)
        bars = [{"date": d, "open": c, "high": c, "low": c, "close": c, "vol": 1.0} for d, c in zip(days, closes)]
        s = P.seasonality(bars, [], today=dt.date(2026, 6, 20))
        apr = s["months"][3]
        self.assertEqual(apr["n"], 4); self.assertEqual(apr["win"], 100); self.assertGreater(apr["avg"], 5)
        self.assertEqual(s["strong"][0]["month"], 4)
        self.assertEqual(s["months"][0]["n"], 3, "2023-01 是第一個月（不完整），不列入")
        self.assertEqual(s["to"], "2026-05")
        june = [y for y in s["table"] if y["year"] == 2026][0]["months"][5]
        self.assertTrue(june["partial"])
        self.assertIn("本月（6 月）", s["headline"]["text"])


class HolderTests(unittest.TestCase):
    def test_levels(self):
        self.assertEqual(P.level_of("1-999"), 1)
        self.assertEqual(P.level_of("1,000-5,000"), 2)
        self.assertEqual(P.level_of("400,001-600,000"), 12)
        self.assertEqual(P.level_of("more than 1,000,001"), 15)
        self.assertEqual(P.level_of("total"), 17)
        self.assertEqual(P.level_of("差異數調整（說明4）"), 16)

    def test_tdcc_csv_and_history(self):
        fresh_cache()
        rows = ["資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%"]
        for code, big in (("2330", 70.0), ("6207", 40.0)):
            for lv in range(1, 16):
                pct = big if lv == 15 else (100 - big) / 14
                rows.append("20260925,%s,%d,%d,%d,%.2f" % (code, lv, 1000 if lv < 15 else 50, pct * 1e6, pct))
            rows.append("20260925,%s,16,0,0,0.00" % code)
            rows.append("20260925,%s,17,14050,100000000,100.00" % code)
        text = "﻿" + "\n".join(rows)
        parsed = P.parse_tdcc(text)
        self.assertEqual(parsed["date"], "2026-09-25")
        self.assertEqual(parsed["rows"]["2330"][15][2], 70.0)
        with patch.object(T, "http_get_json", return_value=text) as g, TC.operation():
            weeks = P.tdcc_weeks("6207")
            self.assertEqual(g.call_count, 1)
            self.assertEqual(len(weeks), 1)
            P.tdcc_weeks("2330")
            self.assertEqual(g.call_count, 1, "同一週只下載一次")
        # 全市場摘要已記錄：沒開過的 2330 也有歷史
        self.assertEqual(list(TC.read(TC.key_for("tdcc-holding-v1", "2330"))), ["2026-09-25"])
        h = P.holders(weeks, make_bars([100] * 5, start="2026-09-21"), "集保")
        self.assertEqual(h["big1000"], 40.0)
        self.assertEqual(h["people"], 14050)
        self.assertEqual(h["big1000_people"], 50)
        self.assertIn("只有 2026-09-25 一週", h["headline"]["text"])
        self.assertEqual(len(h["distribution"]), 15)

    def test_holder_trend(self):
        weeks = [{"date": "2026-08-%02d" % d, "summary": [10000 - i * 100, 50 + i * 0.3, 60.0, 30.0, 40, 1e8]}
                 for i, d in enumerate((7, 14, 21, 28))] + [{"date": "2026-09-04", "summary": [9500, 51.5, 61.0, 29.0, 42, 1e8]}]
        h = P.holders(weeks, make_bars([100] * 30, start="2026-08-03"))
        self.assertAlmostEqual(h["ch4"], 1.5)
        self.assertEqual(h["headline"]["tone"], "up")
        self.assertEqual(h["people_ch4"], -5.0)


# ---------- FinMind 回應格式的假資料：確認 Live 的欄位解析 ----------
def finmind_fixture(url, params=None, headers=None, raw_text=False, **kw):
    if raw_text:
        return None                     # 集保開放資料：這組測試不提供
    ds, did = params.get("dataset"), params.get("data_id")
    first, last = params.get("start_date"), params.get("end_date")
    days = [d for d in trading_days(first, 4000) if d <= last] if first else []
    def ok(rows):
        return {"status": 200, "msg": "success", "data": rows}
    if ds == "TaiwanStockInfo":
        return ok([{"stock_id": "2330", "stock_name": "台積電", "type": "twse", "industry_category": "半導體業", "date": "2026-09-30"}])
    if ds == "TaiwanStockPrice":
        base = 20000.0 if did == "TAIEX" else 500.0
        return ok([{"date": d, "stock_id": did, "Trading_Volume": 30000000 + i % 7 * 1e6, "Trading_money": 1.0,
                    "open": base + i % 11, "max": base + i % 11 + 5, "min": base + i % 11 - 5, "close": base + (i % 11) * (1 if i % 2 else -0.5),
                    "spread": 0, "Trading_turnover": 1} for i, d in enumerate(days)])
    if ds == "TaiwanStockDividendResult":
        return ok([{"date": d, "stock_id": did, "before_price": 510.0, "after_price": 505.0, "stock_and_cache_dividend": 5.0,
                    "stock_or_cache_dividend": "除息", "max_price": 1, "min_price": 1, "open_price": 505, "reference_price": 505.0}
                   for d in days if d[5:] in ("07-15", "07-16")][:12])
    if ds == "TaiwanStockShareholding":
        return ok([{"date": d, "stock_id": did, "stock_name": "台積電", "InternationalCode": "TW0002330008",
                    "ForeignInvestmentRemainingShares": 1, "ForeignInvestmentShares": 18000000000 + i * 1e6,
                    "ForeignInvestmentRemainRatio": 28.0, "ForeignInvestmentSharesRatio": 72.0 + i * 0.001,
                    "ForeignInvestmentUpperLimitRatio": 100.0, "ChineseInvestmentUpperLimitRatio": 0,
                    "NumberOfSharesIssued": 25932000000, "RecentlyDeclareDate": "", "note": ""} for i, d in enumerate(days)])
    if ds == "TaiwanDailyShortSaleBalances":
        return ok([{"stock_id": did, "date": d, "MarginShortSalesCurrentDayBalance": 300000, "SBLShortSalesCurrentDayBalance": 30000000 + i * 1000}
                   for i, d in enumerate(days)])
    if ds == "TaiwanStockMarginPurchaseShortSale":
        return ok([{"date": d, "stock_id": did, "ShortSaleTodayBalance": 300, "MarginPurchaseTodayBalance": 1} for d in days])
    if ds == "TaiwanStockDayTrading":
        return ok([{"stock_id": did, "date": d, "BuyAfterSale": "Y", "Volume": 6000000, "BuyAmount": 1, "SellAmount": 1} for d in days])
    if ds in ("TaiwanStockFinancialStatements", "TaiwanStockCashFlowsStatement"):
        rows = []
        for d in days:
            if d[5:] not in ("03-31", "06-30", "09-30", "12-31"):
                continue
            if ds == "TaiwanStockFinancialStatements":
                rows += [{"date": d, "stock_id": did, "type": t, "value": v, "origin_name": n} for t, v, n in (
                    ("Revenue", 800e9, "營業收入合計"), ("GrossProfit", 450e9, "營業毛利（毛損）淨額"),
                    ("OperatingIncome", 380e9, "營業利益（損失）"), ("IncomeAfterTaxes", 330e9, "本期淨利（淨損）"), ("EPS", 12.5, "基本每股盈餘（元）"))]
            else:
                q = (int(d[5:7]) - 1) // 3 + 1
                rows += [{"date": d, "stock_id": did, "type": "CashFlowsFromOperatingActivities", "value": 400e9 * q, "origin_name": "營業活動之淨現金流入（流出）"},
                         {"date": d, "stock_id": did, "type": "PropertyAndPlantAndEquipment", "value": -250e9 * q, "origin_name": "取得不動產、廠房及設備"}]
        return ok(rows)
    if ds == "USStockPrice":
        return ok([{"date": d, "stock_id": did, "Adj_Close": 1, "Close": 100 + i % 5, "High": 1, "Low": 1, "Open": 1, "Volume": 1}
                   for i, d in enumerate(days)])
    if ds == "TaiwanStockHoldingSharesPer":
        return None                     # 模擬非贊助會員（HTTP 400）
    raise AssertionError("未預期的資料集 %s" % ds)


class LiveParsingTests(unittest.TestCase):
    def setUp(self):
        fresh_cache()

    def test_all_parts_from_finmind_shaped_rows(self):
        calls = []
        def spy(url, params=None, **kw):
            calls.append((params or {}).get("dataset"))
            return finmind_fixture(url, params, **kw)
        with patch.object(T, "http_get_json", side_effect=spy):
            out = {}
            for part in P.PART_KEYS:
                with TC.operation():
                    out[part] = P.build("2330", part, token="t", demo=False)
        self.assertEqual(out["risk"]["name"], "台積電")
        for part in ("risk", "us", "vp", "foreign", "short", "margins", "dividend", "season"):
            self.assertTrue(out[part]["available"], "%s：%s" % (part, out[part].get("reason")))
        self.assertFalse(out["holders"]["available"], "沒有贊助權限、集保也取不到時照實標示")
        self.assertAlmostEqual(out["foreign"]["ratio"], 72.0, delta=1)
        self.assertEqual(out["foreign"]["issued"], 25932000.0)
        self.assertAlmostEqual(out["risk"]["turnover"], 30000 * 1000 / 25932000000 * 100, delta=0.02)
        self.assertEqual(out["short"]["sbl"]["margin_short"], 300)
        self.assertGreater(out["short"]["sbl"]["balance"], 30000)      # 股 → 張
        self.assertTrue(6000 / 36000 * 100 - 0.1 <= out["short"]["daytrade"]["latest"] <= 6000 / 30000 * 100 + 0.1, "當沖 6,000 張 ÷ 總量 30,000～36,000 張")
        self.assertEqual(out["margins"]["gm"], 56.2)
        self.assertEqual(out["margins"]["quality"], round(400 / 330, 2))
        self.assertEqual(out["margins"]["fcf4"], round(4 * 150e9, 0))
        self.assertEqual(out["dividend"]["rows"][0]["kind"], "除息")
        self.assertEqual(len(out["us"]["rows"]), 6)
        self.assertEqual(out["us"]["rows"][0]["source"], "FinMind")
        # 第二次：都走快取（只剩近 7 日的例行確認，不會重抓整段）
        n = len(calls)
        with patch.object(T, "http_get_json", side_effect=spy), TC.operation():
            P.build("2330", "season", token="t")
        self.assertLessEqual(len(calls) - n, 3)

    def test_holders_sponsor_rows(self):
        def fixture(url, params=None, **kw):
            if params and params.get("dataset") == "TaiwanStockHoldingSharesPer":
                rows = []
                for w, d in enumerate(("2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25")):
                    for lvl, pct in (("1-999", 5.0), ("1,000-5,000", 10.0), ("400,001-600,000", 5.0),
                                     ("more than 1,000,001", 60.0 + w)):
                        rows.append({"date": d, "stock_id": "2330", "HoldingSharesLevel": lvl, "people": 100, "percent": pct, "unit": 1000})
                    rows.append({"date": d, "stock_id": "2330", "HoldingSharesLevel": "total", "people": 5000 - w * 10, "percent": 100, "unit": 1e8})
                return {"status": 200, "data": rows}
            return finmind_fixture(url, params, **kw)
        with patch.object(T, "http_get_json", side_effect=fixture), TC.operation():
            h = P.build("2330", "holders", token="sponsor")
        self.assertTrue(h["available"])
        self.assertEqual(h["weeks"], 5)
        self.assertEqual(h["big1000"], 64.0)
        self.assertEqual(h["ch4"], 4.0)
        self.assertEqual(h["big400"], 69.0)
        self.assertEqual(h["holder_source"], "FinMind 股東持股分級")


class ServerTests(unittest.TestCase):
    def setUp(self):
        fresh_cache()
        S.DEMO_MODE = True
        S._power_cache.clear()
        self.server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); S.DEMO_MODE = False

    def get(self, query):
        with urllib.request.urlopen(self.base + "/api/power?" + urllib.parse.urlencode(query), timeout=60) as r:
            return json.loads(r.read())

    def test_every_part(self):
        for part in P.PART_KEYS:
            j = self.get({"code": "2330", "part": part, "us": "mu"})
            self.assertTrue(j["ok"]); self.assertEqual(j["data"]["part"], part)
            self.assertTrue(j["data"]["available"], part)
            json.dumps(j["data"], allow_nan=False)
        self.assertEqual(self.get({"code": "2330", "part": "us", "us": "mu"})["data"]["extra"], ["MU"])
        a = self.get({"code": "2330", "part": "risk"})["data"]["generated"]
        self.assertEqual(self.get({"code": "2330", "part": "risk"})["data"]["generated"], a)
        for bad in ({"code": "2330", "part": "nope"}, {"code": "!!", "part": "risk"}):
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.get(bad)
            self.assertEqual(e.exception.code, 400)

    def test_page_includes_power(self):
        with urllib.request.urlopen(self.base + "/", timeout=30) as r:
            html = r.read().decode()
        self.assertIn('id="power"', html); self.assertIn("window.TWPower", html); self.assertIn('id="btn-power"', html)
        self.assertNotIn("/*__POWERJS__*/", html)


if __name__ == "__main__":
    unittest.main()
