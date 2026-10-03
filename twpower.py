# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""
強力分析（1002a）：一檔股票的九個深入面向，每個分頁各自抓資料、各自計算。

    大戶持股  風險指標卡  美股連動  分價量  外資持股  借券／當沖  三率＋現金流  填息  季節性

原則：只用實際抓到的資料。取不到的部分回傳 available=False 並寫明原因，不用推估值填補。

資料來源（都走本機增量快取，第二次開啟幾乎不用連網）
------------------------------------------------------
* 股價（近 10 年）、除權息結果、三大法人以外的籌碼：FinMind（單一股票查詢免費）
    TaiwanStockPrice、TaiwanStockDividendResult、TaiwanStockShareholding（外資持股）、
    TaiwanDailyShortSaleBalances（借券賣出餘額）、TaiwanStockMarginPurchaseShortSale（融券餘額）、
    TaiwanStockDayTrading（當沖）、TaiwanStockFinancialStatements、TaiwanStockCashFlowsStatement
* 美股：FinMind USStockPrice（^SOX、^IXIC、個股）；取不到時 Stooq，進階設定勾選時再試 Yahoo 財經
* 股東持股分級（大戶持股）：FinMind TaiwanStockHoldingSharesPer 只開放贊助會員；
  沒有權限時改用集保結算所開放資料（每週一份、只有最新一週）。程式每週自動記下全市場摘要，
  之後就能看趨勢。
"""
import bisect
import calendar
import csv
import datetime as _dt
import hashlib
import io
import math
import random
import re
import threading
import time
import zlib

import twboard as T
import twcache as TC
import twmacro as M

PARTS = [("holders", "大戶持股"), ("risk", "風險指標卡"), ("us", "美股連動"), ("vp", "分價量"),
         ("foreign", "外資持股"), ("short", "借券／當沖"), ("margins", "三率＋現金流"),
         ("dividend", "填息"), ("season", "季節性")]
PART_KEYS = [k for k, _ in PARTS]
PART_NAMES = dict(PARTS)

RF = 0.015                  # 無風險利率（年）：約台灣一年期定存
YEAR_DAYS = 252
RISK_WINDOW = 250           # 風險指標：近 250 個交易日（約一年）
US_WINDOW_DAYS = 365        # 美股連動：近一年
US_DEFAULT = [("^SOX", "費城半導體"), ("^IXIC", "那斯達克"), ("NVDA", "輝達"),
              ("TSM", "台積電ADR"), ("AAPL", "蘋果"), ("AMD", "超微")]
US_STOOQ = {"^SOX": "^sox", "^IXIC": "^ndq", "NVDA": "nvda.us", "TSM": "tsm.us", "AAPL": "aapl.us", "AMD": "amd.us"}
US_MAX_EXTRA = 4
VP_WINDOWS = (60, 120, 250)
VP_BINS = 36
TDCC_URLS = ("https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5",
             "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5")
# 集保 15 個持股分級（股數下限）；16＝差異數調整、17＝合計
HOLD_LEVELS = [1, 1000, 5001, 10001, 15001, 20001, 30001, 40001, 50001, 100001, 200001, 400001, 600001, 800001, 1000001]
HOLD_LABELS = ["1-999 股", "1-5 張", "5-10 張", "10-15 張", "15-20 張", "20-30 張", "30-40 張", "40-50 張",
               "50-100 張", "100-200 張", "200-400 張", "400-600 張", "600-800 張", "800-1000 張", "1000 張以上"]
TDCC_CODE = re.compile(r"\d{4}[A-Z]?|00\d{2,3}[A-Z]?")
_denied = {}                # FinMind 贊助限定資料集：本次程序已確認沒有權限（token 雜湊 → 時間）
_denied_lock = threading.Lock()


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def ok(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def rd(v, nd=2):
    return round(v, nd) if ok(v) else None


def pc(v, nd=2):
    """比例 → 百分比數字（0.1234 → 12.34）。"""
    return round(v * 100.0, nd) if ok(v) else None


def mean(xs):
    xs = [x for x in xs if ok(x)]
    return sum(xs) / len(xs) if xs else None


def stdev(xs):
    xs = [x for x in xs if ok(x)]
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def corr(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if ok(x) and ok(y)]
    if len(pairs) < 3:
        return None
    mx = sum(p[0] for p in pairs) / len(pairs)
    my = sum(p[1] for p in pairs) / len(pairs)
    sxx = sum((p[0] - mx) ** 2 for p in pairs)
    syy = sum((p[1] - my) ** 2 for p in pairs)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def slope(xs, ys):
    """ys 對 xs 的迴歸斜率（β）與截距。"""
    pairs = [(x, y) for x, y in zip(xs, ys) if ok(x) and ok(y)]
    if len(pairs) < 3:
        return None, None
    mx = sum(p[0] for p in pairs) / len(pairs)
    my = sum(p[1] for p in pairs) / len(pairs)
    sxx = sum((p[0] - mx) ** 2 for p in pairs)
    if sxx <= 0:
        return None, None
    b = sum((p[0] - mx) * (p[1] - my) for p in pairs) / sxx
    return b, my - b * mx


def quantile(sorted_xs, q):
    if not sorted_xs:
        return None
    pos = (len(sorted_xs) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (pos - lo)


def median(xs):
    xs = sorted(x for x in xs if ok(x))
    return quantile(xs, 0.5) if xs else None


def change(seq, back):
    """seq 最後一個值減 back 筆以前的值；不足回 None。"""
    vals = [v for v in seq if ok(v)]
    if len(vals) <= back:
        return None
    return vals[-1] - vals[-1 - back]


def streak(seq):
    """最後連續幾筆同方向變化：+3＝連 3 日增加、-2＝連 2 日減少、0＝持平。"""
    vals = [v for v in seq if ok(v)]
    n, sign = 0, 0
    for i in range(len(vals) - 1, 0, -1):
        d = vals[i] - vals[i - 1]
        s = 1 if d > 1e-9 else -1 if d < -1e-9 else 0
        if s == 0 or (sign and s != sign):
            break
        sign, n = s, n + 1
    return sign * n


def quarter_label(date):
    y, m = int(date[:4]), int(date[5:7])
    return "%02dQ%d" % (y % 100, (m - 1) // 3 + 1)


def quarter_end(y, m):
    return "%04d-%02d-%02d" % (y, m, calendar.monthrange(y, m)[1])


def prev_quarter(date, back=1):
    """季底日期往前 back 季（2026-06-30 → 2026-03-31）。"""
    y, m = int(date[:4]), int(date[5:7])
    k = y * 12 + (m - 1) - 3 * back
    return quarter_end(k // 12, k % 12 + 1)


def unavailable(reason, **extra):
    out = {"available": False, "reason": reason}
    out.update(extra)
    return out


def headline(text, tone="neutral", label=None):
    return {"text": text, "tone": tone, "label": label}


def close_by_date(bars):
    return {b["date"]: b["close"] for b in bars}


def clean_us(text):
    """使用者自己加的美股代號：英數與 ^ . -，最多 4 個，大寫、去重。"""
    out = []
    for t in re.split(r"[,\s，、]+", (text or "").upper()):
        t = t.strip()
        if t and re.fullmatch(r"\^?[A-Z0-9][A-Z0-9.\-]{0,9}", t) and t not in out \
                and t not in [x for x, _ in US_DEFAULT]:
            out.append(t)
    return out[:US_MAX_EXTRA]


# --------------------------------------------------------------------------
# 報酬：除權息日用參考價計算，排除除權息造成的「假下跌」
# --------------------------------------------------------------------------

def ex_bases(dividends):
    """{除權息日: 參考價}。只收合理的參考價（介於 0 與除權息前收盤價之間）。"""
    out = {}
    for d in dividends or []:
        before = d.get("before")
        base = d.get("reference") or d.get("after")
        if not ok(base) and ok(before) and ok(d.get("amount")):
            base = before - d["amount"]
        if ok(base) and base > 0 and (not ok(before) or 0.3 * before <= base <= before):
            out[d["date"]] = base
    return out


def daily_returns(bars, dividends=None):
    """[(日期, 日報酬)]；除權息日的基準改用參考價。"""
    bases = ex_bases(dividends)
    out = []
    for i in range(1, len(bars)):
        c, prev = bars[i]["close"], bars[i - 1]["close"]
        base = bases.get(bars[i]["date"], prev)
        if ok(c) and ok(base) and base > 0 and c > 0:
            out.append((bars[i]["date"], c / base - 1.0))
    return out


SPLIT_JUMP = 0.35          # 單日漲跌超過 35%（台股漲跌幅上限 10%）幾乎只可能是股票分割、減資這類公司行動


def price_jumps(bars, dividends=None):
    """異常跳價只是待確認訊號，不能當成分割比例。"""
    return [d for d, r in daily_returns(bars, dividends) if abs(r) > SPLIT_JUMP]


def splits(bars, dividends=None, actions=None):
    """僅採來源確認的分割／面額變更前價、參考價，保留當天真實漲跌。"""
    by_date = {b["date"]: i for i, b in enumerate(bars)}
    out = {}
    for a in actions or []:
        i = by_date.get(a.get("date"))
        before, reference = a.get("before"), a.get("reference")
        if (i is not None and i > 0 and ok(before) and ok(reference)
                and before > 0 and reference > 0
                and abs(bars[i - 1]["close"] / before - 1) < 0.02):
            out[i] = before / reference
    return sorted(out.items())


def adjust_for_splits(bars, dividends=None, actions=None):
    """把分割／減資以前的價格換算成最新的單位（成交量反向換算），股價圖與報酬才不會出現假的斷崖。

    回傳 (換算後的 K 棒, 換算後的除權息, [{"date", "ratio"}])；除權息保留原始的權息值與除權息前價供表格顯示。"""
    sp = splits(bars, dividends, actions)
    if not sp:
        return bars, dividends, []
    ratio = dict(sp)
    factor, f = [1.0] * len(bars), 1.0
    for i in range(len(bars) - 1, -1, -1):
        factor[i] = f
        if i in ratio:
            f *= ratio[i]
    adj = []
    for b, k in zip(bars, factor):
        nb = dict(b)
        for key in ("open", "high", "low", "close"):
            if ok(nb.get(key)):
                nb[key] = nb[key] / k
        if ok(nb.get("vol")):
            nb["vol"] = nb["vol"] * k
        adj.append(nb)
    divs = None
    if dividends is not None:
        dates = [b["date"] for b in bars]
        divs = []
        for d in dividends:
            i = bisect.bisect_left(dates, d["date"])
            fb, fa = factor[max(0, min(i, len(bars)) - 1)], factor[min(i, len(bars) - 1)]
            nd = dict(d, orig_before=d.get("before"), orig_amount=d.get("amount"))
            for key, k in (("before", fb), ("amount", fb), ("after", fa), ("reference", fa)):
                if ok(nd.get(key)):
                    nd[key] = nd[key] / k
            divs.append(nd)
    return adj, divs, [{"date": bars[i]["date"], "ratio": rd(r, 3)} for i, r in sp]


# --------------------------------------------------------------------------
# 1. 風險指標卡
# --------------------------------------------------------------------------

def risk(bars, dividends=None, bench=None, issued_shares=None, window=RISK_WINDOW, rf=RF):
    rets = daily_returns(bars, dividends)[-window:]
    if len(rets) < 60:
        return unavailable("股價資料不足 60 個交易日，無法計算風險指標。")
    rs = [x for _, x in rets]
    n = len(rs)
    growth = 1.0
    index = [1.0]
    for x in rs:
        growth *= 1 + x
        index.append(growth)
    ann = growth ** (YEAR_DAYS / n) - 1
    mu, sd = mean(rs), stdev(rs)
    vol = sd * math.sqrt(YEAR_DAYS) if sd else None
    excess = mu * YEAR_DAYS - rf
    sharpe = excess / vol if vol else None
    down = math.sqrt(sum(min(x, 0.0) ** 2 for x in rs) / n) * math.sqrt(YEAR_DAYS)
    sortino = excess / down if down > 0 else None
    # 回撤：用報酬指數（已排除除權息缺口）
    pos = {b["date"]: i for i, b in enumerate(bars)}
    start_i = max(0, pos[rets[0][0]] - 1)
    dates = [bars[start_i]["date"]] + [d for d, _ in rets]
    peak, peak_i, mdd, mdd_peak, mdd_trough = index[0], 0, 0.0, 0, 0
    dd = []
    for i, v in enumerate(index):
        if v > peak:
            peak, peak_i = v, i
        cur = v / peak - 1
        dd.append(cur)
        if cur < mdd:
            mdd, mdd_peak, mdd_trough = cur, peak_i, i
    calmar = ann / abs(mdd) if mdd < 0 else None
    srt = sorted(rs)
    var95 = quantile(srt, 0.05)
    tail = [x for x in rs if x <= var95]
    cvar95 = mean(tail)
    # 大盤 β 與相關（大盤是價格指數，逐日對齊）
    beta = rho = None
    bench_n = 0
    if bench:
        bd = sorted(bench)
        bret = {}
        for i in range(1, len(bd)):
            a, b = bench[bd[i - 1]], bench[bd[i]]
            if ok(a) and ok(b) and a > 0:
                bret[bd[i]] = b / a - 1
        xs, ys = [], []
        for d, x in rets:
            if d in bret:
                xs.append(bret[d]); ys.append(x)
        bench_n = len(xs)
        if bench_n >= 60:
            beta, _ = slope(xs, ys)
            rho = corr(xs, ys)
    turnover = None
    if ok(issued_shares) and issued_shares > 0:
        vols = [b["vol"] * 1000.0 for b in bars[-n:] if ok(b.get("vol"))]
        turnover = mean(vols) / issued_shares if vols else None
    if (vol or 0) > 0.45 or mdd < -0.35:
        level = headline("波動大、跌起來深，部位宜小、停損要設", "crit", "高風險")
    elif (vol or 0) > 0.25 or mdd < -0.2:
        level = headline("波動中等，進出要留意回檔幅度", "warn", "中風險")
    else:
        level = headline("波動相對小，走勢較穩", "good", "低風險")
    cmap = close_by_date(bars)
    closes = [cmap.get(d) for d in dates]
    return {
        "available": True, "headline": level, "from": dates[0], "to": dates[-1], "days": n, "rf_pct": pc(rf, 1),
        "annual_return": pc(ann), "sharpe": rd(sharpe), "sortino": rd(sortino), "calmar": rd(calmar),
        "up_ratio": pc(sum(x > 0 for x in rs) / n, 1),
        "volatility": pc(vol, 1), "beta": rd(beta), "correlation": rd(rho), "bench_days": bench_n,
        "turnover": pc(turnover, 2),
        "max_drawdown": pc(mdd, 1), "mdd_peak": dates[mdd_peak], "mdd_trough": dates[mdd_trough],
        "from_high": pc(dd[-1], 1), "var95": pc(var95), "cvar95": pc(cvar95),
        "chart": {"date": dates, "close": closes, "drawdown": [pc(v, 2) for v in dd]},
    }


# --------------------------------------------------------------------------
# 2. 美股連動
# --------------------------------------------------------------------------

def _strength(c):
    if not ok(c):
        return "—"
    a = abs(c)
    return "幾乎無" if a < 0.1 else "弱" if a < 0.3 else "中" if a < 0.5 else "強"


def us_pairs(tw_rets, us_closes):
    """配對：台股第 t 日 ↔ 前一個台股交易日（含）到 t 之前的美股報酬（多天就連乘）。
    美股收盤在台股收盤之後，所以「同一個日曆日」的美股影響的是台股下一個交易日。"""
    us = sorted((d, c) for d, c in us_closes if ok(c) and c > 0)
    ur = [(us[i][0], us[i][1] / us[i - 1][1] - 1) for i in range(1, len(us))]
    udates = [d for d, _ in ur]
    nxt, same = [], []
    umap = dict(ur)
    for i in range(1, len(tw_rets)):
        prev_t, t = tw_rets[i - 1][0], tw_rets[i][0]
        lo, hi = bisect.bisect_left(udates, prev_t), bisect.bisect_left(udates, t)
        if hi > lo and (_dt.date.fromisoformat(t) - _dt.date.fromisoformat(prev_t)).days <= 10:
            g = 1.0
            for j in range(lo, hi):
                g *= 1 + ur[j][1]
            nxt.append((g - 1, tw_rets[i][1], t, udates[hi - 1]))
    for d, r in tw_rets:
        if d in umap:
            same.append((umap[d], r, d))
    return nxt, same, ur


def us_link(tw_rets, us_data, names, window_days=US_WINDOW_DAYS):
    if len(tw_rets) < 60:
        return unavailable("台股股價資料不足，無法計算美股連動。")
    cutoff = (_dt.date.fromisoformat(tw_rets[-1][0]) - _dt.timedelta(days=window_days)).isoformat()
    rows = []
    for ticker, name in names:
        series = us_data.get(ticker) or {}
        closes = series.get("rows") or []
        if len(closes) < 40:
            rows.append({"ticker": ticker, "name": name, "available": False,
                         "reason": series.get("reason") or "取不到美股資料"})
            continue
        nxt, same, ur = us_pairs(tw_rets, closes)
        nxt = [p for p in nxt if p[2] >= cutoff]
        same = [p for p in same if p[2] >= cutoff]
        if len(nxt) < 30:
            rows.append({"ticker": ticker, "name": name, "available": False, "reason": "配對樣本不足 30 天"})
            continue
        xs, ys = [p[0] for p in nxt], [p[1] for p in nxt]
        c_next, c_same = corr(xs, ys), corr([p[0] for p in same], [p[1] for p in same])
        b, a = slope(xs, ys)
        signs = [(x > 0) == (y > 0) for x, y in zip(xs, ys) if x != 0 and y != 0]
        up = [y for x, y in zip(xs, ys) if x >= 0.02]
        dn = [y for x, y in zip(xs, ys) if x <= -0.02]
        rows.append({
            "ticker": ticker, "name": name, "available": True, "source": series.get("source"),
            "corr_next": rd(c_next, 2), "strength": _strength(c_next), "corr_same": rd(c_same, 2),
            "beta": rd(b, 2), "alpha": rd(a, 5), "same_dir": pc(sum(signs) / len(signs), 0) if signs else None,
            "up2": {"n": len(up), "avg": pc(mean(up)), "prob": pc(sum(y > 0 for y in up) / len(up), 0) if up else None},
            "down2": {"n": len(dn), "avg": pc(mean(dn)), "prob": pc(sum(y < 0 for y in dn) / len(dn), 0) if dn else None},
            "latest": {"date": ur[-1][0], "ret": pc(ur[-1][1])} if ur else None,
            "n": len(nxt),
            "scatter": [[pc(x), pc(y), t] for x, y, t, _ in nxt],
        })
    good = [r for r in rows if r.get("available") and ok(r.get("corr_next"))]
    if not good:
        return unavailable("取不到美股資料或配對樣本不足。", rows=rows)
    best = max(good, key=lambda r: r["corr_next"])
    text = "最有領先效果：%s（%s）· 隔日相關 %.2f（%s）· 同向率 %s%%" % (
        best["name"], best["ticker"], best["corr_next"], best["strength"],
        "—" if best["same_dir"] is None else "%.0f" % best["same_dir"])
    return {"available": True, "headline": headline(text, "neutral"), "best": best["ticker"],
            "from": cutoff, "to": tw_rets[-1][0], "rows": rows}


# --------------------------------------------------------------------------
# 3. 分價量（籌碼成本分佈）
# --------------------------------------------------------------------------

def volume_profile(bars, windows=VP_WINDOWS, bins=VP_BINS):
    if len(bars) < 20:
        return unavailable("股價資料不足，無法計算分價量。")
    out = {"available": True, "windows": {}, "close": bars[-1]["close"], "date": bars[-1]["date"]}
    for w in windows:
        sub = [b for b in bars[-w:] if ok(b.get("vol")) and ok(b.get("high")) and ok(b.get("low"))]
        if len(sub) < 10:
            continue
        lo, hi = min(b["low"] for b in sub), max(b["high"] for b in sub)
        if hi <= lo:
            hi = lo * 1.01 + 0.01
        step = (hi - lo) / bins
        up, dn = [0.0] * bins, [0.0] * bins
        for b in sub:
            a, z = b["low"], max(b["high"], b["low"])
            first, last = min(bins - 1, int((a - lo) / step)), min(bins - 1, int((z - lo) / step))
            span = max(z - a, 1e-9)
            for k in range(first, last + 1):
                blo, bhi = lo + k * step, lo + (k + 1) * step
                share = (min(bhi, z) - max(blo, a)) / span if z > a else 1.0 / (last - first + 1)
                target = up if b["close"] >= b.get("open", b["close"]) else dn
                target[k] += b["vol"] * max(0.0, share)
        total = [u + d for u, d in zip(up, dn)]
        vol_sum = sum(total) or 1.0
        poc = max(range(bins), key=lambda k: total[k])
        a, z, acc = poc, poc, total[poc]
        while acc < 0.7 * vol_sum and (a > 0 or z < bins - 1):
            left = total[a - 1] if a > 0 else -1
            right = total[z + 1] if z < bins - 1 else -1
            if right >= left:
                z += 1; acc += total[z]
            else:
                a -= 1; acc += total[a]
        close = sub[-1]["close"]
        levels = [{"lo": rd(lo + k * step), "hi": rd(lo + (k + 1) * step), "mid": rd(lo + (k + .5) * step),
                   "up": rd(up[k], 1), "down": rd(dn[k], 1), "pct": pc(total[k] / vol_sum, 2)} for k in range(bins)]
        vah, val = lo + (z + 1) * step, lo + a * step
        top = sorted(range(bins), key=lambda k: -total[k])[:8]
        above = [k for k in top if lo + (k + .5) * step > close]
        below = [k for k in top if lo + (k + .5) * step <= close]
        resist = min(above, key=lambda k: lo + k * step) if above else None
        support = max(below, key=lambda k: lo + k * step) if below else None
        where = "above" if close > vah else "below" if close < val else "inside"
        out["windows"][str(w)] = {
            "days": len(sub), "from": sub[0]["date"], "to": sub[-1]["date"], "levels": levels,
            "poc": rd(lo + (poc + .5) * step), "vah": rd(vah), "val": rd(val), "where": where,
            "value_pct": pc(acc / vol_sum, 1),
            "resist": levels[resist] if resist is not None else None,
            "support": levels[support] if support is not None else None,
            "top": [levels[k] for k in top],
        }
    w = out["windows"].get("120") or next(iter(out["windows"].values()), None)
    if not w:
        return unavailable("股價資料不足，無法計算分價量。")
    c = out["close"]
    if w["where"] == "above":
        h = headline("收盤 %s 在價值區上方（VAH %s），上方籌碼較少，套牢壓力輕" % (T.r2(c), w["vah"]), "up")
    elif w["where"] == "below":
        h = headline("收盤 %s 跌破價值區（VAL %s），上方有大量套牢籌碼" % (T.r2(c), w["val"]), "down")
    else:
        h = headline("收盤 %s 在價值區內（%s～%s），最大量價位 POC %s" % (T.r2(c), w["val"], w["vah"], w["poc"]), "neutral")
    out["headline"] = h
    return out


# --------------------------------------------------------------------------
# 4. 外資持股
# --------------------------------------------------------------------------

def foreign(rows, bars, keep=250):
    rows = [r for r in rows if ok(r.get("ratio"))]
    if len(rows) < 2:
        return unavailable("取不到外資持股資料（FinMind TaiwanStockShareholding）。")
    rows.sort(key=lambda r: r["date"])
    ratio = [r["ratio"] for r in rows]
    last = rows[-1]
    ch5, ch20, ch60 = change(ratio, 5), change(ratio, 20), change(ratio, 60)
    st = streak(ratio)
    remain = last.get("remain")
    limit = last.get("limit")
    if not ok(remain) and ok(limit):
        remain = limit - last["ratio"]
    if ok(ch20) and ch20 <= -1:
        h = headline("外資一個月減碼超過 1 個百分點，長線資金撤出", "down")
    elif ok(ch20) and ch20 >= 1:
        h = headline("外資一個月加碼超過 1 個百分點，長線資金進駐", "up")
    elif ok(ch5) and ch5 >= 0.5:
        h = headline("外資近一週加碼 %.2f 個百分點" % ch5, "up")
    elif ok(ch5) and ch5 <= -0.5:
        h = headline("外資近一週減碼 %.2f 個百分點" % -ch5, "down")
    else:
        h = headline("外資持股變化不大（20 日 %s 個百分點）" % ("—" if ch20 is None else "%+.2f" % ch20), "neutral")
    room = None
    if ok(remain):
        room = "外資還有加碼空間" if remain >= 10 else "接近外資投資上限" if remain < 3 else "加碼空間有限"
    closes = close_by_date(bars)
    view = rows[-keep:]
    return {
        "available": True, "headline": h, "date": last["date"], "ratio": rd(last["ratio"]),
        "streak": st, "ch5": rd(ch5), "ch20": rd(ch20), "ch60": rd(ch60),
        "limit": rd(limit), "remain": rd(remain), "room": room,
        "shares": rd(last.get("shares"), 0), "issued": rd(last.get("issued"), 0),
        "chart": {"date": [r["date"] for r in view], "ratio": [rd(r["ratio"]) for r in view],
                  "close": [closes.get(r["date"]) for r in view]},
    }


# --------------------------------------------------------------------------
# 5. 借券／當沖
# --------------------------------------------------------------------------

def sbl_unit(balances, margin):
    """借券表的單位：跟融資融券表（張）比對融券餘額，約 1000 倍就是「股」。預設股。"""
    ratios = []
    for r in balances[-40:]:
        m = (margin.get(r["date"]) or {}).get("short_bal")
        x = r.get("margin_short")
        if ok(m) and m > 20 and ok(x) and x > 0:
            ratios.append(x / m)
    med = median(ratios)
    return 1.0 if med is not None and med < 30 else 1000.0


def short_daytrade(balances, margin, daytrade, bars, keep=140):
    out = {"available": False}
    vols = {b["date"]: b["vol"] for b in bars if ok(b.get("vol"))}
    closes = close_by_date(bars)
    rows = sorted([r for r in balances if ok(r.get("sbl"))], key=lambda r: r["date"])
    if len(rows) >= 2:
        unit = sbl_unit(rows, margin or {})
        sbl = [r["sbl"] / unit for r in rows]
        last = sbl[-1]
        c5, c20 = change(sbl, 5), change(sbl, 20)
        base20 = sbl[-21] if len(sbl) > 20 else None
        pct20 = (last / base20 - 1) if ok(base20) and base20 > 0 else None
        recent_vol = [vols[d] for d in sorted(vols)[-20:]]
        avg20 = mean(recent_vol)
        dtc = last / avg20 if avg20 else None
        mshort = None
        md = sorted(d for d in (margin or {}) if ok((margin[d] or {}).get("short_bal")))
        if md:
            mshort = margin[md[-1]]["short_bal"]
        elif ok(rows[-1].get("margin_short")):
            mshort = rows[-1]["margin_short"] / unit
        if ok(pct20) and pct20 >= 0.2:
            h = headline("借券賣出餘額 20 日增加逾兩成，法人空方布局升溫", "down")
        elif ok(pct20) and pct20 <= -0.2:
            h = headline("借券賣出餘額 20 日減少逾兩成，空方回補中", "up")
        elif ok(dtc) and dtc >= 5:
            h = headline("借券賣出餘額約等於 %.1f 天成交量，回補壓力大" % dtc, "warn")
        else:
            h = headline("借券賣出餘額 20 日變化 %s，變化不大" % ("—" if pct20 is None else "%+.1f%%" % (pct20 * 100)), "neutral")
        view = list(zip(rows, sbl))[-keep:]
        out.update({"available": True, "headline": h, "sbl": {
            "date": rows[-1]["date"], "balance": rd(last, 0), "ch5": rd(c5, 0), "ch20": rd(c20, 0),
            "pct20": pc(pct20, 1), "days_to_cover": rd(dtc, 1), "avg_vol20": rd(avg20, 0),
            "margin_short": rd(mshort, 0),
            "chart": {"date": [r["date"] for r, _ in view], "balance": [rd(v, 0) for _, v in view],
                      "close": [closes.get(r["date"]) for r, _ in view]}}})
    else:
        out["sbl"] = unavailable("取不到借券賣出餘額（FinMind TaiwanDailyShortSaleBalances）。")
    dt = []
    for r in sorted(daytrade or [], key=lambda r: r["date"]):
        v = vols.get(r["date"])
        if ok(r.get("volume")) and ok(v) and v > 0:
            dt.append((r["date"], min(100.0, r["volume"] / v * 100.0)))
    if len(dt) >= 3:
        ratios = [x for _, x in dt]
        a5, a20 = mean(ratios[-5:]), mean(ratios[-20:])
        flag = ("過熱：當沖佔比過高，股價容易暴漲暴跌" if (a5 or 0) >= 40 else
                "偏高：短線資金進出頻繁" if (a5 or 0) >= 25 else "正常")
        out["daytrade"] = {"available": True, "date": dt[-1][0], "latest": rd(ratios[-1], 1),
                           "avg5": rd(a5, 1), "avg20": rd(a20, 1), "flag": flag, "hot": (a5 or 0) >= 40,
                           "chart": {"date": [d for d, _ in dt[-60:]], "ratio": [rd(x, 1) for _, x in dt[-60:]]}}
        if not out["available"]:
            out["available"] = True
            out["headline"] = headline("當沖比率 5 日平均 %.1f%%（%s）" % (a5, flag.split("：")[0]), "warn" if (a5 or 0) >= 40 else "neutral")
    else:
        out["daytrade"] = unavailable("取不到當沖資料（FinMind TaiwanStockDayTrading）。")
    if not out["available"]:
        return unavailable("取不到借券與當沖資料。", sbl=out.get("sbl"), daytrade=out.get("daytrade"))
    return out


# --------------------------------------------------------------------------
# 6. 三率＋現金流
# --------------------------------------------------------------------------

STATEMENT_TYPES = {
    "revenue": (("Revenue", "OperatingRevenue", "TotalOperatingRevenue"), ("營業收入合計", "營業收入", "收入合計")),
    "gross": (("GrossProfit",), ("營業毛利（毛損）淨額", "營業毛利（毛損）", "營業毛利")),
    "operating": (("OperatingIncome",), ("營業利益（損失）", "營業利益")),
    "net": (("IncomeAfterTaxes", "IncomeFromContinuingOperations", "EquityAttributableToOwnersOfParent", "NetIncome"),
            ("本期淨利（淨損）", "本期淨利")),
    "eps": (("EPS",), ("基本每股盈餘（元）", "基本每股盈餘")),
}
CASH_TYPES = {
    "cfo": (("CashFlowsFromOperatingActivities", "NetCashInflowFromOperatingActivities", "CashProvidedByOperatingActivities"),
            ("營業活動之淨現金流入（流出）", "營業活動之淨現金流入")),
    "capex": (("PropertyAndPlantAndEquipment", "AcquisitionOfPropertyPlantAndEquipment"),
              ("取得不動產、廠房及設備", "取得不動產及設備")),
}


def _pick(rows, spec):
    types, names = spec
    by_type = {r.get("type"): r for r in rows}
    for t in types:
        if t in by_type and ok(T.to_float(by_type[t].get("value"))):
            return T.to_float(by_type[t]["value"])
    for n in names:
        for r in rows:
            if str(r.get("origin_name") or "").startswith(n) and ok(T.to_float(r.get("value"))):
                return T.to_float(r["value"])
    return None


def statements_by_quarter(stmt_rows, cash_rows):
    """損益表（單季）＋現金流量表（年初累計 → 換算單季）→ [{date, q, revenue, gross, operating, net, eps, cfo, capex}]"""
    per, cash = {}, {}
    for r in stmt_rows or []:
        if isinstance(r, dict) and isinstance(r.get("date"), str):
            per.setdefault(r["date"], []).append(r)
    for r in cash_rows or []:
        if isinstance(r, dict) and isinstance(r.get("date"), str):
            cash.setdefault(r["date"], []).append(r)
    out = []
    for d in sorted(set(per) | set(cash)):
        row = {"date": d, "q": quarter_label(d)}
        for k, spec in STATEMENT_TYPES.items():
            row[k] = _pick(per.get(d, []), spec)
        for k, spec in CASH_TYPES.items():
            row[k + "_cum"] = _pick(cash.get(d, []), spec)
        out.append(row)
    by = {r["date"]: r for r in out}
    for r in out:
        m = int(r["date"][5:7])
        prev = None if m <= 3 else by.get(prev_quarter(r["date"]))
        for k in ("cfo", "capex"):
            cum = r[k + "_cum"]
            if m <= 3:
                r[k] = cum
            else:
                p = prev.get(k + "_cum") if prev else None
                r[k] = cum - p if ok(cum) and ok(p) else None
    return out


def margins(quarters, keep=12):
    qs = [q for q in quarters if ok(q.get("revenue")) or ok(q.get("net"))]
    if not qs:
        return unavailable("取不到財報資料（FinMind TaiwanStockFinancialStatements）。")
    for q in qs:
        rev = q.get("revenue")
        for k, name in (("gross", "gm"), ("operating", "om"), ("net", "nm")):
            q[name] = q[k] / rev * 100 if ok(q.get(k)) and ok(rev) and rev > 0 else None
    by = {q["date"]: q for q in qs}
    last = qs[-1]
    prev = by.get(prev_quarter(last["date"]), {})
    yoy = by.get(prev_quarter(last["date"], 4), {})
    def delta(k, other):
        return rd(last[k] - other[k], 1) if ok(last.get(k)) and ok(other.get(k)) else None
    four = [by[d] for d in (prev_quarter(last["date"], i) for i in (3, 2, 1, 0)) if d in by]
    eps4 = sum(q["eps"] for q in four) if len(four) == 4 and all(ok(q.get("eps")) for q in four) else None
    cfo4 = sum(q["cfo"] for q in four) if len(four) == 4 and all(ok(q.get("cfo")) for q in four) else None
    net4 = sum(q["net"] for q in four) if len(four) == 4 and all(ok(q.get("net")) for q in four) else None
    capex4 = sum(abs(q["capex"]) for q in four) if len(four) == 4 and all(ok(q.get("capex")) for q in four) else None
    fcf4 = cfo4 - capex4 if ok(cfo4) and ok(capex4) else None
    quality = cfo4 / net4 if ok(cfo4) and ok(net4) and net4 > 0 else None
    if ok(net4) and net4 <= 0:
        h = headline("近四季合計虧損，現金流與獲利都要留意", "crit")
    elif ok(quality) and quality >= 1:
        h = headline("獲利品質佳：近四季營業現金流 ≥ 稅後淨利", "good")
    elif ok(quality):
        h = headline("獲利品質待觀察：近四季營業現金流只有稅後淨利的 %.0f%%" % (quality * 100), "warn")
    else:
        h = headline("最新一季 %s：毛利率 %s%%" % (last["q"], "—" if last.get("gm") is None else "%.1f" % last["gm"]), "neutral")
    moves = [delta(k, prev) for k in ("gm", "om", "nm")]
    if all(ok(m) and m > 0 for m in moves):
        trend = "三率三升：毛利率、營益率、淨利率都比上一季好"
    elif all(ok(m) and m < 0 for m in moves):
        trend = "三率三降：毛利率、營益率、淨利率都比上一季差"
    else:
        trend = "三率走勢分歧，需搭配營收看"
    view = qs[-keep:]
    return {
        "available": True, "headline": h, "trend": trend, "latest": last["q"], "date": last["date"],
        "gm": rd(last.get("gm"), 1), "om": rd(last.get("om"), 1), "nm": rd(last.get("nm"), 1),
        "gm_qoq": delta("gm", prev), "gm_yoy": delta("gm", yoy), "om_qoq": delta("om", prev), "om_yoy": delta("om", yoy),
        "nm_qoq": delta("nm", prev), "nm_yoy": delta("nm", yoy),
        "eps": rd(last.get("eps")), "eps4": rd(eps4), "cfo4": rd(cfo4, 0), "net4": rd(net4, 0),
        "quality": rd(quality), "fcf4": rd(fcf4, 0), "capex4": rd(capex4, 0),
        "no_revenue": not ok(last.get("revenue")),
        "chart": {"q": [q["q"] for q in view], "gm": [rd(q.get("gm"), 1) for q in view],
                  "om": [rd(q.get("om"), 1) for q in view], "nm": [rd(q.get("nm"), 1) for q in view],
                  "cfo": [rd(q.get("cfo"), 0) for q in view], "net": [rd(q.get("net"), 0) for q in view],
                  "eps": [rd(q.get("eps")) for q in view]},
    }


# --------------------------------------------------------------------------
# 7. 填息
# --------------------------------------------------------------------------

def dividend_fill(bars, dividends, trading_dates=None):
    events = sorted([d for d in dividends or [] if ok(d.get("before")) and d["before"] > 0 and ok(d.get("amount"))
                     and d["amount"] > 0], key=lambda d: d["date"])
    if not events:
        return unavailable("近 10 年查無除權息紀錄（或取不到除權息資料）。")
    dates = [b["date"] for b in bars]
    closes = [b["close"] for b in bars]
    rows, excluded = [], []
    for e in events:
        i = bisect.bisect_left(dates, e["date"])
        if i == 0 or i >= len(dates) or dates[i] != e["date"]:
            excluded.append({"date": e["date"], "reason": "缺少除權息日或之前的股價，歷史不足"})
            continue
        filled = None
        for k in range(i, len(dates)):
            if closes[k] >= e["before"] - 1e-9:
                filled = k
                break
        end = filled if filled is not None else len(dates) - 1
        if trading_dates is not None:
            required = {d for d in trading_dates if e["date"] <= d <= dates[end]}
            if not required or not required.issubset(set(dates[i:end + 1])):
                excluded.append({"date": e["date"], "reason": "觀察期間有缺漏交易日，無法確認填息天數"})
                continue
        elapsed = len(dates) - 1 - i
        kind = e.get("kind") or "除權息"
        row = {"date": e["date"], "kind": kind, "amount": rd(e.get("orig_amount") or e["amount"], 4),
               "before": rd(e.get("orig_before") or e["before"]),
               "yield": pc(e["amount"] / e["before"], 2), "cash": "息" in kind and "權" not in kind,
               "elapsed": elapsed}
        if filled is not None:
            row.update({"filled": True, "days": filled - i, "fill_date": dates[filled]})
        else:
            row.update({"filled": False, "days": None, "gap": pc(e["before"] / closes[-1] - 1, 2),
                        "target": rd(e["before"])})
        rows.append(row)
    if not rows:
        return unavailable("歷史不足或觀察期間有缺漏，無法計算填息。", excluded=excluded)
    def rate(limit):
        pool = [r for r in rows if r["elapsed"] >= limit]
        hit = [r for r in pool if r["filled"] and r["days"] <= limit]
        return (pc(len(hit) / len(pool), 0) if pool else None), len(pool)
    same, n0 = rate(0)
    r20, n20 = rate(20)
    r60, n60 = rate(60)
    filled_days = [r["days"] for r in rows if r["filled"]]
    cash_yields = [r["yield"] for r in rows if r["cash"] and ok(r["yield"])]
    last = rows[-1]
    if not last["filled"]:
        h = headline("最近一次（%s）尚未填息，已過 %d 個交易日，距填息價 %s 還差 %+.2f%%" %
                     (last["date"], last["elapsed"], T.r2(last["target"]), last["gap"]), "warn")
    elif last["days"] == 0:
        h = headline("最近一次（%s）除權息當天就填息" % last["date"], "good")
    else:
        h = headline("最近一次（%s）花 %d 個交易日填息（%s）" % (last["date"], last["days"], last["fill_date"]), "good")
    grade = None
    if r60 is not None:
        grade = "填息能力強" if r60 >= 80 else "填息能力普通" if r60 >= 60 else "填息能力偏弱"
    return {
        "available": True, "headline": h, "count": len(rows), "first": rows[0]["date"][:4], "last": rows[-1]["date"][:4],
        "same_day": same, "same_n": n0, "within20": r20, "n20": n20, "within60": r60, "n60": n60, "grade": grade,
        "excluded": excluded, "avg_days": rd(mean(filled_days), 0), "median_days": rd(median(filled_days), 0), "filled": len(filled_days),
        "avg_yield": rd(mean(cash_yields), 2), "rows": list(reversed(rows)),
        "close": bars[-1]["close"], "price_from": dates[0],
    }


# --------------------------------------------------------------------------
# 8. 季節性
# --------------------------------------------------------------------------

def seasonality(bars, dividends=None, today=None, trading_dates=None):
    rets = daily_returns(bars, dividends)
    if len(rets) < 200:
        return unavailable("股價資料不足一年，無法統計季節性。")
    months = {}
    for d, r in rets:
        months.setdefault(d[:7], []).append(r)
    keys = sorted(months)
    first_month = bars[0]["date"][:7]
    today = today or TC.today()
    cur = today.isoformat()[:7]
    table, complete = {}, []
    observed = {b["date"] for b in bars}
    last_month = bars[-1]["date"][:7]
    market_months = {}
    for d in trading_dates or []:
        market_months.setdefault(d[:7], set()).add(d)
    for k in keys:
        if k == first_month:
            continue                      # 第一個月不完整（缺月初），不統計
        g = 1.0
        for r in months[k]:
            g *= 1 + r
        if abs(g - 1) < 1e-9:
            g = 1.0                       # 換算單位時的浮點誤差：整個月平盤就是 0，不算漲也不算跌
        y, m = int(k[:4]), int(k[5:7])
        reason = "本月尚未結束" if k >= cur else ""
        if not reason:
            if trading_dates is None:
                if k >= last_month:
                    reason = "尚無下一月份資料，無法確認月底完整性"
            else:
                expected = market_months.get(k, set())
                if not market_months or k >= max(market_months):
                    reason = "市場日曆尚未跨月，無法確認月底完整性"
                earlier = [d for d in trading_dates if d < k + "-01"]
                if (not expected or not expected.issubset(observed)
                        or not earlier or max(earlier) not in observed):
                    reason = "缺少交易日或上月底基準價"
        partial = bool(reason)
        table.setdefault(y, {})[m] = {"ret": pc(g - 1, 1), "partial": partial, "reason": reason}
        if not partial:
            complete.append((y, m, g - 1))
    stats = []
    for m in range(1, 13):
        xs = [x for _, mm, x in complete if mm == m]
        stats.append({"month": m, "n": len(xs), "avg": pc(mean(xs), 1),
                      "win": pc(sum(x > 0 for x in xs) / len(xs), 0) if xs else None})
    ranked = [s for s in stats if s["n"] > 0 and ok(s["avg"])]
    strong = sorted(ranked, key=lambda s: -s["avg"])[:3]
    weak = sorted(ranked, key=lambda s: s["avg"])[:3]
    this_m = today.month
    next_m = this_m % 12 + 1
    years = max([s["n"] for s in stats] or [0])
    def say(m, prefix):
        s = stats[m - 1]
        if not s["n"] or not ok(s["avg"]):
            return "尚無完整月份"
        return "%s %s%%、平均 %+.1f%%" % (prefix, "—" if s["win"] is None else "%.0f" % s["win"], s["avg"])
    text = "本月（%d 月）%s（%d 年）；下個月（%d 月）%s" % (
        this_m, say(this_m, "歷史勝率"), stats[this_m - 1]["n"], next_m, say(next_m, "勝率"))
    if years < 5:
        text += "。樣本只有 %d 年，僅供參考" % years
    tone = "up" if ok(stats[this_m - 1]["avg"]) and stats[this_m - 1]["avg"] > 0 else \
        "down" if ok(stats[this_m - 1]["avg"]) and stats[this_m - 1]["avg"] < 0 else "neutral"
    return {
        "available": True, "headline": headline(text, tone), "months": stats, "strong": strong, "weak": weak,
        "from": "%04d-%02d" % (complete[0][0], complete[0][1]) if complete else None,
        "to": "%04d-%02d" % (complete[-1][0], complete[-1][1]) if complete else None,
        "complete": len(complete), "years": years, "this_month": this_m, "next_month": next_m,
        "table": [{"year": y, "months": [table[y].get(m) for m in range(1, 13)]} for y in sorted(table, reverse=True)],
    }


# --------------------------------------------------------------------------
# 9. 大戶持股（集保股東持股分級）
# --------------------------------------------------------------------------

def level_of(text):
    """FinMind HoldingSharesLevel 字串 → 1～17。"""
    s = str(text or "").strip().lower()
    if not s:
        return None
    if s in ("total", "合計") or "total" in s:
        return 17
    if "差異" in s or "adjust" in s:
        return 16
    nums = [int(x.replace(",", "")) for x in re.findall(r"\d[\d,]*", s)]
    if not nums:
        return None
    low = nums[0]
    if low in HOLD_LEVELS:
        return HOLD_LEVELS.index(low) + 1
    if 1 <= low <= 17 and len(nums) == 1 and "more" not in s:
        return low
    for i in range(len(HOLD_LEVELS) - 1, -1, -1):
        if low >= HOLD_LEVELS[i]:
            return i + 1
    return None


def holder_summary(levels):
    """levels：{分級: (人數, 股數, 比例%)} → [總人數, 千張%, 400張以上%, 散戶(≤50張)%, 千張人數, 總股數]"""
    total = levels.get(17)
    tot_people = total[0] if total else sum(v[0] for k, v in levels.items() if k <= 15)
    tot_shares = total[1] if total else sum(v[1] for k, v in levels.items() if k <= 15)
    pct = lambda ks: sum(levels[k][2] for k in ks if k in levels)
    return [tot_people, round(pct([15]), 2), round(pct(range(12, 16)), 2), round(pct(range(1, 9)), 2),
            levels.get(15, (0, 0, 0))[0], tot_shares]


def parse_tdcc(text):
    """集保開放資料 CSV：資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例% → {date, rows:{code:{分級:[人數,股數,比例]}}}"""
    if not text or not isinstance(text, str):
        return None
    rows, day = {}, None
    for rec in csv.reader(io.StringIO(text.lstrip("﻿"))):
        if len(rec) < 6:
            continue
        d, code = rec[0].strip(), rec[1].strip()
        # 只留股票（4 碼、4 碼＋英文字）與 ETF（00 開頭）；權證、債券等幾萬檔不存，快取才不會越長越大
        if not re.fullmatch(r"\d{8}", d) or not TDCC_CODE.fullmatch(code):
            continue
        try:
            lv = int(rec[2]); people = int(float(rec[3].replace(",", ""))); shares = float(rec[4].replace(",", ""))
            ratio = float(rec[5].replace(",", ""))
        except ValueError:
            continue
        day = "%s-%s-%s" % (d[:4], d[4:6], d[6:])
        rows.setdefault(code, {})[lv] = [people, shares, ratio]
    rows = {c: lv for c, lv in rows.items() if (lv.get(17) or [0])[0] > 0 or (lv.get(15) or [0])[0] > 0}
    if not rows or not day:
        return None
    return {"date": day, "rows": rows}


def holders(weeks, bars, source=""):
    """weeks：[{date, levels:{分級:(人數,股數,比例)}}]（日期由舊到新；只有最新一週時只給分布）"""
    weeks = [w for w in weeks if w.get("summary") or w.get("levels")]
    if not weeks:
        return unavailable("取不到集保股權分散資料。")
    for w in weeks:
        if not w.get("summary"):
            w["summary"] = holder_summary(w["levels"])
    weeks.sort(key=lambda w: w["date"])
    s = [w["summary"] for w in weeks]
    big = [x[1] for x in s]
    b400 = [x[2] for x in s]
    retail = [x[3] for x in s]
    people = [x[0] for x in s]
    last = weeks[-1]
    latest_levels = next((w["levels"] for w in reversed(weeks) if w.get("levels")), None)
    dist = None
    if latest_levels:
        dist = [{"level": HOLD_LABELS[k - 1], "people": latest_levels[k][0], "shares": latest_levels[k][1],
                 "pct": rd(latest_levels[k][2])} for k in range(1, 16) if k in latest_levels]
    ch1, ch4 = change(big, 1), change(big, 4)
    p4 = (people[-1] / people[-5] - 1) if len(people) > 4 and people[-5] else None
    if len(weeks) == 1:
        h = headline("目前只有 %s 一週的集保資料；程式每週會自動記錄，之後就能看大戶增減趨勢" % last["date"], "neutral")
    elif ok(ch4) and ch4 >= 0.5 and (p4 is None or p4 <= 0):
        h = headline("千張大戶 4 週增加 %.2f 個百分點%s，籌碼往大戶集中" %
                     (ch4, "" if p4 is None else "、股東人數減少 %.1f%%" % (-p4 * 100)), "up")
    elif ok(ch4) and ch4 <= -0.5:
        h = headline("千張大戶 4 週減少 %.2f 個百分點%s，籌碼分散" %
                     (-ch4, "" if p4 is None or p4 <= 0 else "、股東人數增加 %.1f%%" % (p4 * 100)), "down")
    else:
        h = headline("大戶持股變化不大（%s千張大戶 %s 個百分點）" %
                     ("4 週" if ok(ch4) else "1 週", "—" if not ok(ch4 if ok(ch4) else ch1) else "%+.2f" % (ch4 if ok(ch4) else ch1)),
                     "neutral")
    closes = close_by_date(bars)
    dates = [b["date"] for b in bars]
    def close_on(d):
        i = bisect.bisect_right(dates, d) - 1
        return closes[dates[i]] if i >= 0 else None
    avg_shares = last["summary"][5] / last["summary"][0] / 1000.0 if last["summary"][0] else None
    return {
        "available": True, "headline": h, "holder_source": source, "date": last["date"], "weeks": len(weeks),
        "big1000": rd(big[-1]), "big400": rd(b400[-1]), "retail": rd(retail[-1]), "people": people[-1],
        "big1000_people": last["summary"][4], "avg_lots": rd(avg_shares, 1),
        "ch1": rd(ch1), "ch4": rd(ch4), "people_ch4": pc(p4, 1),
        "b400_ch4": rd(change(b400, 4)), "retail_ch4": rd(change(retail, 4)),
        "distribution": dist,
        "chart": {"date": [w["date"] for w in weeks], "big1000": [rd(x) for x in big], "big400": [rd(x) for x in b400],
                  "retail": [rd(x) for x in retail], "people": people, "close": [close_on(w["date"]) for w in weeks]},
    }


# --------------------------------------------------------------------------
# 資料來源：實際連網（本機增量快取）
# --------------------------------------------------------------------------

def _years_ago(end, years):
    return (end - _dt.timedelta(days=int(years * 365.25))).isoformat()


class Live:
    """一次分頁請求用的資料來源；同一次請求內重複要同一份資料只抓一次。"""

    def __init__(self, code, token="", ep=None, refresh=False):
        self.code, self.token, self.ep, self.refresh = code, token or "", ep or T.DEFAULT_ENDPOINTS, refresh
        self.end = TC.today()
        self._memo = {}
        self.sources = set()

    def _once(self, name, fn):
        if name not in self._memo:
            self._memo[name] = fn()
        return self._memo[name]

    def _fm(self, dataset, start, end=None, data_id=None, max_age=None, schedule="tw"):
        """FinMind 逐日快取；鍵與主畫面相同（同一份股價、融資券資料可以共用）。"""
        ep, headers = self.ep, ({"Authorization": "Bearer " + self.token} if self.token else {})
        data_id = self.code if data_id is None else data_id
        key = TC.key_for("finmind-v2", ep["finmind"], dataset, data_id)

        def fetch(first, last):
            params = {"dataset": dataset, "start_date": first, "end_date": last}
            if data_id:
                params["data_id"] = data_id
            j = T.http_get_json(ep["finmind"], params, headers=headers)
            if not j or j.get("status") not in (200, "200"):
                return None
            return j.get("data") if isinstance(j.get("data"), list) else None
        return TC.range_data(key, start, end or self.end.isoformat(), fetch, max_age=max_age,
                             refresh_recent=self.refresh, schedule=schedule)

    # ---- 共用 ----
    def info(self):
        def get():
            rows = T.fm("TaiwanStockInfo", self.code, self.end.isoformat(), self.end.isoformat(), self.token, self.ep) or []
            rows = [r for r in rows if r.get("stock_id") == self.code]
            if not rows:
                return {"name": self.code, "market": None}
            row = max(rows, key=lambda r: str(r.get("date") or ""))
            return {"name": row.get("stock_name") or self.code, "market": str(row.get("type", "")).lower() or None,
                    "industry": row.get("industry_category")}
        return self._once("info", get)

    def bars(self):
        def get():
            TC.report("股價", "近 %d 年日K" % T.HISTORY_YEARS)
            rows = self._fm("TaiwanStockPrice", _years_ago(self.end, T.HISTORY_YEARS))
            bars = T._finmind_bars(rows) if rows else []
            if bars:
                self.sources.add("FinMind")
            return bars
        return self._once("bars", get)

    def actions(self):
        def get():
            rows = []
            for dataset, before, reference in (
                    ("TaiwanStockSplitPrice", "before_price", "after_price"),
                    ("TaiwanStockParValueChange", "before_close", "after_ref_close")):
                for r in self._fm(dataset, _years_ago(self.end, T.HISTORY_YEARS), data_id="", schedule="tw_once") or []:
                    if r.get("stock_id") == self.code:
                        rows.append({"date": r.get("date"), "before": T.to_float(r.get(before)),
                                     "reference": T.to_float(r.get(reference)), "source": dataset})
            return rows
        return self._once("actions", get)

    def calendar(self):
        def get():
            rows = self._fm("TaiwanStockPrice", _years_ago(self.end, T.HISTORY_YEARS), data_id="TAIEX")
            return sorted({r["date"] for r in rows or [] if r.get("stock_id") == "TAIEX" and ok(T.to_float(r.get("close")))}) or None
        return self._once("calendar", get)

    def dividends(self):
        def get():
            TC.report("除權息", "近 %d 年除權息結果" % T.HISTORY_YEARS)
            rows = T.fm("TaiwanStockDividendResult", self.code, _years_ago(self.end, T.HISTORY_YEARS),
                        self.end.isoformat(), self.token, self.ep)
            out = []
            for r in rows or []:
                if isinstance(r, dict) and isinstance(r.get("date"), str):
                    out.append({"date": r["date"], "kind": str(r.get("stock_or_cache_dividend") or "除權息"),
                                "amount": T.to_float(r.get("stock_and_cache_dividend")),
                                "before": T.to_float(r.get("before_price")),
                                "after": T.to_float(r.get("after_price")),
                                "reference": T.to_float(r.get("reference_price"))})
            return out if rows is not None else None
        return self._once("dividends", get)

    def bench(self):
        def get():
            market = self.info().get("market")
            bid = {"twse": "TAIEX", "tpex": "TPEx"}.get(market, "TAIEX")
            TC.report("大盤", "價格指數（β 與相關係數）")
            rows = self._fm("TaiwanStockPrice", _years_ago(self.end, 1.6), data_id=bid) or []
            return {r["date"]: T.to_float(r.get("close")) for r in rows
                    if r.get("stock_id") == bid and ok(T.to_float(r.get("close")))}
        return self._once("bench", get)

    def shareholding(self):
        def get():
            TC.report("外資持股", "外資持股比率與發行股數")
            rows = self._fm("TaiwanStockShareholding", _years_ago(self.end, 1.3)) or []
            out = []
            for r in rows:
                shares, issued = T.to_float(r.get("ForeignInvestmentShares")), T.to_float(r.get("NumberOfSharesIssued"))
                out.append({"date": r["date"], "ratio": T.to_float(r.get("ForeignInvestmentSharesRatio")),
                            "limit": T.to_float(r.get("ForeignInvestmentUpperLimitRatio")),
                            "remain": T.to_float(r.get("ForeignInvestmentRemainRatio")),
                            "shares": shares / 1000.0 if ok(shares) else None,
                            "issued": issued / 1000.0 if ok(issued) else None})
            return sorted(out, key=lambda r: r["date"])
        return self._once("shareholding", get)

    def short_balances(self):
        def get():
            TC.report("借券", "借券賣出餘額")
            rows = self._fm("TaiwanDailyShortSaleBalances", _years_ago(self.end, 0.8)) or []
            return [{"date": r["date"], "sbl": T.to_float(r.get("SBLShortSalesCurrentDayBalance")),
                     "margin_short": T.to_float(r.get("MarginShortSalesCurrentDayBalance"))} for r in rows]
        return self._once("short", get)

    def margin(self):
        def get():
            rows = self._fm("TaiwanStockMarginPurchaseShortSale", _years_ago(self.end, 0.3)) or []
            return {r["date"]: {"short_bal": T.to_float(r.get("ShortSaleTodayBalance"))} for r in rows}
        return self._once("margin", get)

    def daytrade(self):
        def get():
            TC.report("當沖", "現股當沖成交量")
            rows = self._fm("TaiwanStockDayTrading", _years_ago(self.end, 0.4)) or []
            out = []
            for r in rows:
                v = T.to_float(r.get("Volume"))
                out.append({"date": r["date"], "volume": v / 1000.0 if ok(v) else None})
            return out
        return self._once("daytrade", get)

    def statements(self):
        def get():
            start = _years_ago(self.end, 4.2)
            TC.report("財報", "綜合損益表與現金流量表")
            got = TC.parallel([
                # 1003a：財報一季有效（到手後下一季公布期才再查），不再每 3 天整段重抓。
                ("綜合損益表", lambda: self._fm("TaiwanStockFinancialStatements", start, schedule="quarterly")),
                ("現金流量表", lambda: self._fm("TaiwanStockCashFlowsStatement", start, schedule="quarterly"))])
            return statements_by_quarter(got[0], got[1])
        return self._once("statements", get)

    def us(self, ticker):
        def get():
            s, e = _years_ago(self.end, 1.3), self.end.isoformat()
            ep = dict(self.ep, _force_recent=self.refresh)
            rows = M._fm_rows("USStockPrice", ticker, s, e, self.token, ep,
                              lambda r: T.to_float(r.get("Close")) if r.get("stock_id") in (ticker, None) else None,
                              schedule="us")
            label = "FinMind"
            def stale(rs):
                return not rs or (self.end - _dt.date.fromisoformat(max(r["date"] for r in rs))).days > 7
            if stale(rows) and ticker in US_STOOQ:
                fb = M._stooq_rows(US_STOOQ[ticker], s, e, ep)
                if fb and not stale(fb):
                    rows, label = fb, "Stooq"
            if stale(rows) and self.ep.get("_yahoo"):
                fb = M._yahoo_rows(ticker, s, e, ep)
                if fb and not stale(fb):
                    rows, label = fb, M.YAHOO_LABEL
            if not rows:
                return {"rows": [], "reason": "取不到 %s 的美股資料" % ticker}
            by = {r["date"]: r["value"] for r in rows}
            return {"rows": sorted(by.items()), "source": label}
        return self._once("us:" + ticker, get)

    def holders(self):
        def get():
            th = hashlib.sha256(self.token.encode()).hexdigest()
            with _denied_lock:
                denied = time.time() - _denied.get(th, 0) < 6 * 3600
            weeks, source = [], ""
            if self.token and not denied:
                TC.report("大戶持股", "FinMind 股東持股分級（贊助會員）")
                before = list((TC.state() or {}).get("warnings", []))
                rows = self._fm("TaiwanStockHoldingSharesPer", _years_ago(self.end, 1.2), schedule="weekly")
                if rows:
                    per = {}
                    for r in rows:
                        lv = level_of(r.get("HoldingSharesLevel"))
                        if lv:
                            per.setdefault(r["date"], {})[lv] = (T.to_float(r.get("people"), 0), T.to_float(r.get("unit"), 0),
                                                                 T.to_float(r.get("percent"), 0))
                    weeks = [{"date": d, "levels": lv} for d, lv in sorted(per.items()) if 15 in lv or 17 in lv]
                    source = "FinMind 股東持股分級"
                else:
                    with _denied_lock:
                        _denied[th] = time.time()
                    M._forget_warnings("", before, list((TC.state() or {}).get("warnings", [])))
            if not weeks:
                TC.report("大戶持股", "集保結算所開放資料（最新一週）")
                weeks = tdcc_weeks(self.code)
                source = "集保結算所開放資料"
            if weeks:
                self.sources.add(source.split(" ")[0] if source.startswith("FinMind") else source)
            return {"weeks": weeks, "source": source}
        return self._once("holders", get)


def _tdcc_latest():
    key = TC.key_for("tdcc-holding-latest-v1")

    def fetch():
        for url in TDCC_URLS:
            text = T.http_get_json(url, raw_text=True, timeout=45)
            parsed = parse_tdcc(text)
            if parsed:
                return parsed
        return None
    return TC.response(key, fetch, lambda d: isinstance(d, dict) and bool(d.get("rows")), 12 * 3600, kind="market-day")


def tdcc_weeks(code):
    """集保最新一週（全市場）→ 每週把全市場摘要記到各股的歷史鍵；回傳這檔的所有週（最新一週附完整分布）。"""
    latest = _tdcc_latest()
    hist_key = TC.key_for("tdcc-holding-v1", code)
    if latest:
        mark = TC.key_for("tdcc-holding-recorded-v1")
        if latest["date"] not in TC.read(mark):
            items = []
            for c, lv in latest["rows"].items():
                levels = {int(k): tuple(v) for k, v in lv.items()}
                if 17 in levels or 15 in levels:
                    items.append((TC.key_for("tdcc-holding-v1", c), latest["date"], holder_summary(levels)))
            if TC.write_many(items):
                TC.write(mark, {latest["date"]: 1})
    weeks = [{"date": d, "summary": v} for d, (v, _) in sorted(TC.read(hist_key).items()) if isinstance(v, list)]
    if latest and code in latest["rows"]:
        levels = {int(k): tuple(v) for k, v in latest["rows"][code].items()}
        weeks = [w for w in weeks if w["date"] != latest["date"]] + [{"date": latest["date"], "levels": levels,
                                                                     "summary": holder_summary(levels)}]
    return weeks


# --------------------------------------------------------------------------
# 示範資料（--demo）：與真實資料同格式，讓九個分頁都看得到畫面
# --------------------------------------------------------------------------

class Demo(Live):
    def __init__(self, code, token="", ep=None, refresh=False):
        super().__init__(code, token, ep, refresh)
        self.seed = zlib.crc32(code.encode("utf-8"))
        self.raw = T.fetch_demo(code, days=260, history_days=T.DEMO_HISTORY)
        self.sources = {"合成資料（非真實行情）"}

    def rnd(self, salt):
        return random.Random(self.seed + zlib.crc32(salt.encode()))

    def info(self):
        return {"name": self.raw["name"], "market": "twse", "industry": "示範"}

    def bars(self):
        return self.raw["history"] or self.raw["bars"]

    def dividends(self):
        def get():
            bars, rnd, out = self.bars(), self.rnd("div"), []
            by_year = {}
            for i, b in enumerate(bars):
                by_year.setdefault(b["date"][:4], []).append(i)
            for y, idx in sorted(by_year.items()):
                cand = [i for i in idx if b_month(bars[i]) in (6, 7, 8) and i > 0]
                if not cand:
                    continue
                i = cand[rnd.randrange(len(cand))]
                before = bars[i - 1]["close"]
                amt = round(before * rnd.uniform(0.015, 0.06), 2)
                out.append({"date": bars[i]["date"], "kind": "除息", "amount": amt, "before": before,
                            "after": round(before - amt, 2), "reference": round(before - amt, 2)})
            return out
        return self._once("dividends", get)

    def bench(self):
        return self.raw["bench"]["series"]

    def shareholding(self):
        bars, rnd = self.bars()[-300:], self.rnd("fx")
        ratio, out = rnd.uniform(8, 45), []
        for b in bars:
            ratio = min(70, max(1, ratio + rnd.gauss(0, 0.25)))
            out.append({"date": b["date"], "ratio": round(ratio, 2), "limit": 100.0, "remain": round(100 - ratio, 2),
                        "shares": round(ratio / 100 * 250000, 0), "issued": 250000.0})
        return out

    def short_balances(self):
        bars, rnd = self.bars()[-180:], self.rnd("sbl")
        bal, out = rnd.uniform(2e6, 8e6), []
        for b in bars:
            bal = max(0, bal * (1 + rnd.gauss(0.002, 0.03)))
            out.append({"date": b["date"], "sbl": round(bal), "margin_short": None})
        return out

    def margin(self):
        return {d: {"short_bal": v["short_bal"]} for d, v in self.raw["margin"].items()}

    def daytrade(self):
        bars, rnd = self.bars()[-90:], self.rnd("dt")
        return [{"date": b["date"], "volume": round(b["vol"] * min(0.8, max(0.05, rnd.gauss(0.32, 0.1))), 1)} for b in bars]

    def statements(self):
        rnd, out = self.rnd("fin"), []
        rev = rnd.uniform(3e9, 2e10)
        end = TC.today()
        y, q = end.year, (end.month - 1) // 3
        qs = []
        for _ in range(14):
            q -= 1
            if q <= 0:
                q += 4; y -= 1
            qs.append((y, q))
        cum = {}
        for y, q in sorted(qs):
            rev *= 1 + rnd.gauss(0.02, 0.08)
            gm, om = rnd.uniform(0.22, 0.4), rnd.uniform(0.04, 0.2)
            net = rev * om * rnd.uniform(0.7, 1.1)
            cfo = net * rnd.uniform(0.6, 1.6)
            capex = -rev * rnd.uniform(0.02, 0.08)
            m = q * 3
            d = "%04d-%02d-%02d" % (y, m, 30 if m in (6, 9) else 31)
            c = cum.setdefault(y, [0.0, 0.0])
            c[0] += cfo; c[1] += capex
            out.append({"date": d, "q": quarter_label(d), "revenue": rev, "gross": rev * gm, "operating": rev * om,
                        "net": net, "eps": round(net / 2.5e8, 2), "cfo_cum": c[0], "capex_cum": c[1],
                        "cfo": cfo, "capex": capex})
        return out

    def us(self, ticker):
        rets = daily_returns(self.bars())[-320:]
        rnd = self.rnd("us" + ticker)
        k = {"^SOX": .35, "^IXIC": .3, "NVDA": .25, "TSM": .3, "AAPL": .05, "AMD": .2}.get(ticker, .1)
        rows, px = [], 100.0
        for i in range(len(rets) - 1):
            d = (_dt.date.fromisoformat(rets[i][0])).isoformat()
            px *= 1 + k * rets[i + 1][1] / 0.021 * 0.018 + rnd.gauss(0, 0.017)
            rows.append((d, round(px, 3)))
        return {"rows": rows, "source": "合成資料（非真實行情）"}

    def holders(self):
        bars, rnd = self.bars(), self.rnd("hold")
        weeks, big = [], rnd.uniform(35, 70)
        people = rnd.uniform(2e4, 9e4)
        fridays = [b["date"] for b in bars[-160:] if _dt.date.fromisoformat(b["date"]).weekday() == 4]
        for d in fridays:
            big = min(90, max(10, big + rnd.gauss(0, 0.4)))
            people = max(1000, people * (1 + rnd.gauss(0, 0.01)))
            weeks.append({"date": d, "summary": [round(people), round(big, 2), round(big + 8, 2), round(max(1, 100 - big - 20), 2),
                                                 round(people * 0.0008), 250000000.0]})
        pct = [max(0.1, (100 - big - 20) / 8)] * 8 + [3, 3, 3, 3, 3, 2] + [big]
        tot = sum(pct)
        levels = {i + 1: (round(people * (0.5 if i == 0 else 0.3 / (i + 1))), 250000000.0 * p / tot, round(p / tot * 100, 2))
                  for i, p in enumerate(pct)}
        levels[17] = (round(people), 250000000.0, 100.0)
        weeks[-1] = {"date": weeks[-1]["date"], "levels": levels, "summary": holder_summary(levels)}
        return {"weeks": weeks, "source": "合成資料（非真實行情）"}


def b_month(bar):
    return int(bar["date"][5:7])


# --------------------------------------------------------------------------
# 組裝
# --------------------------------------------------------------------------

def build(code, part, token="", ep=None, demo=False, us_extra=(), refresh=False):
    if part not in PART_KEYS:
        raise ValueError("未知的分析項目")
    src = (Demo if demo else Live)(code, token, ep, refresh)
    info = src.info()
    raw_bars = src.bars()
    if not raw_bars:
        raise ValueError("取不到 %s 的股價資料。請確認代號，或在進階設定填入 FinMind Token 後再試。" % code)
    need_div = part in ("risk", "us", "dividend", "season")
    raw_divs = src.dividends() if need_div else None
    candidates = price_jumps(raw_bars, raw_divs)
    actions = src.actions() if candidates and not demo else []
    bars, divs, split_list = adjust_for_splits(raw_bars, raw_divs, actions)
    unresolved = price_jumps(bars, divs)
    calendar_dates = ([b["date"] for b in bars] if demo else src.calendar()) if part in ("season", "dividend") else None
    if part in ("season", "dividend") and not calendar_dates:
        TC.warn("交易日曆取得失敗，無法確認歷史資料完整性。")
    if unresolved:
        TC.warn("異常跳價尚未取得可核對的分割／面額變更參考價：" + "、".join(unresolved))
    if part == "risk":
        issued = next((r["issued"] * 1000.0 for r in reversed(src.shareholding()) if ok(r.get("issued"))), None)
        data = risk(bars, divs, src.bench(), issued)
    elif part == "us":
        names = list(US_DEFAULT) + [(t, t) for t in us_extra]
        got = TC.parallel([(n, (lambda t=t: src.us(t))) for t, n in names], max_workers=4)
        data = us_link(daily_returns(bars, divs), dict(zip([t for t, _ in names], got)), names)
        data["extra"] = list(us_extra)
    elif part == "vp":
        data = volume_profile(bars)
    elif part == "foreign":
        data = foreign(src.shareholding(), bars)
    elif part == "short":
        got = TC.parallel([("借券", src.short_balances), ("融券", src.margin), ("當沖", src.daytrade)])
        data = short_daytrade(got[0], got[1], got[2], bars)
    elif part == "margins":
        data = margins(src.statements())
    elif part == "dividend":
        data = dividend_fill(bars, divs, calendar_dates) if divs is not None else unavailable("取不到除權息資料。")
    elif part == "season":
        data = seasonality(bars, divs, trading_dates=calendar_dates)
    else:
        h = src.holders()
        data = holders(h["weeks"], bars, h["source"])
    if unresolved and part in ("risk", "us", "vp", "dividend", "season"):
        data = unavailable("價格有未確認的公司行動或異常跳價，暫停跨期計算；請重抓資料後再試。")
    if need_div and raw_divs is None:
        data = unavailable("除權息資料未取得，無法確認調整後報酬或填息結果。")
    if part in ("season", "dividend") and not calendar_dates:
        data = unavailable("交易日曆未取得，暫不提供需要完整歷史的統計。")
    if data.get("excluded"):
        TC.warn("已排除 %d 次歷史不足或交易日缺漏的除權息事件。" % len(data["excluded"]))
    sources = sorted(src.sources) or ["FinMind"]
    data.update({"part": part, "part_name": PART_NAMES[part], "code": code, "name": info.get("name") or code,
                 "market": info.get("market"), "last_date": bars[-1]["date"], "close": bars[-1]["close"],
                 "price_from": bars[0]["date"], "generated": _dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
                 "demo": demo, "source": sources[0] if demo else "、".join(sources), "splits": split_list})
    return data
