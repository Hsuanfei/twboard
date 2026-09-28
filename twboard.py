#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""
台股戰略圖產生器 — 分析引擎 (twboard)
=====================================
抓資料、算指標、產生 18 格單檔互動 HTML。

兩種用法
--------
1) 互動版（推薦）：在瀏覽器裡輸入代號、選來源、改天數
       python twserve.py

2) 命令列：直接產生檔案
       python twboard.py 2330
       python twboard.py 2330 3374 3443 --days 60 --out ./out
       python twboard.py 2330 --source twse
       python twboard.py 2330 --token <FinMind token>
       python twboard.py DEMO --demo            # 合成資料，離線試版型

特色
----
* 只用 Python 標準函式庫，不需要 pip install 任何東西。
* 支援上市(TWSE)與上櫃(TPEx)。
* 產出的 HTML 內嵌 ECharts，離線也能開。
* 指標一律用「完整歷史」計算後才切出顯示區間，所以就算只看 30 天，
  MA60 / MACD / RSI 也都是暖身過的正確值。
* 所有分數都是「規則計分」，不是預測，不是勝率。資料不足一律顯示「無資料」。

資料來源
--------
    finmind : api.finmindtrade.com  (一次抓一整段，快；上市櫃都有)
    twse    : www.twse.com.tw       (官方，免 token；法人與融資券需逐日抓，較慢；僅上市)
    auto    : 先 finmind，失敗再 twse (預設)
    API 網址都可以用 --finmind-api / --twse-*-api 覆寫，或在互動版頁面上填。

免責
----
本程式輸出的任何分數、燈號、區間與研判，皆為公開資料經固定規則換算的結果，
不構成投資建議，也不是對未來報酬的預測。
"""

import argparse
import datetime as _dt
import json
import html as _html
import math
import os
import random
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

import twcache as TC
import twpattern as TP

APP_VERSION = "0928a"
APP_TITLE = "台股戰略產生器%s版" % APP_VERSION
APP_CREDIT = "Powered by 黃炫斐(Mick Huang)"
APP_COPYRIGHT = "Copyright (C) 2026 黃炫斐 (Mick Huang)"
APP_LICENSE = "GPL-3.0-only"
# 公開後請填入原始碼網址（例如 GitHub 專案頁）；會顯示在頁尾、匯出報告與命令列啟動訊息。
APP_SOURCE_URL = "https://github.com/Hsuanfei/twboard"

# --------------------------------------------------------------------------
# 基本工具
# --------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

def _ssl_context():
    """仍然驗證憑證鏈與主機名稱，只關掉 Python 3.13 起預設開啟的 X.509「嚴格模式」。

    證交所、櫃買中心的憑證缺少嚴格模式要求的欄位（Subject Key Identifier），
    在 Python 3.13 以上會出現「certificate verify failed: Missing Subject Key Identifier」而連不上；
    瀏覽器與舊版 Python 都接受這些憑證。這不是略過驗證：憑證仍必須由受信任的機構簽發、且網址相符。
    """
    ctx = ssl.create_default_context()
    if hasattr(ssl, "VERIFY_X509_STRICT"):
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


_SSL_CTX = _ssl_context()


def describe_error(e):
    """把連線錯誤翻成看得懂的原因（不含網址參數與 Token）。"""
    r = getattr(e, "reason", e) if isinstance(e, urllib.error.URLError) and not isinstance(e, urllib.error.HTTPError) else e
    if isinstance(e, urllib.error.HTTPError):
        return "HTTP %d" % e.code
    if isinstance(r, ssl.SSLCertVerificationError):
        return "SSL 憑證驗證失敗（%s）" % (getattr(r, "verify_message", "") or getattr(r, "reason", "") or r)
    if isinstance(r, ssl.SSLError):
        return "SSL 連線錯誤（%s）" % (getattr(r, "reason", "") or r)
    if isinstance(r, socket.gaierror):
        return "找不到主機（DNS 查詢失敗，請確認網路是否正常）"
    if isinstance(r, (socket.timeout, TimeoutError)):
        return "連線逾時"
    if isinstance(r, ConnectionRefusedError):
        return "連線被拒絕（可能被防火牆或防毒軟體擋下）"
    if isinstance(r, (ConnectionResetError, ConnectionAbortedError)):
        return "連線被中斷（可能被防火牆、防毒軟體或網站擋下）"
    text = str(r)
    if "proxy" in text.lower():
        return "代理伺服器錯誤（%s）" % text[:100]
    return "%s（%s）" % (type(r).__name__, text[:120])


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


_NET_SLOTS = threading.BoundedSemaphore(8)    # 同時最多 8 條連線，多檔平行時對資料來源仍算客氣


def http_get_json(url, params=None, retries=2, pause=0.6, timeout=20, headers=None, raw_text=False):
    """GET 一個回 JSON 的網址。失敗回 None。

    * 4xx 不重試：重試也不會變好，只會更快把額度耗光；402/429 會明確提示「查詢次數已達上限」。
    * 連線層失敗（斷網、DNS）時，同一次查詢後續請求直接略過，
      讓離線時能在一兩秒內退回本機快取，而不是每個資料集都各等一輪重試。
    """
    st = TC.state()
    host = urllib.parse.urlsplit(url).netloc
    # 以主機為單位：FinMind 連不上不代表證交所也連不上，自動切換來源仍要能運作。
    if st is not None and host in st.get("offline_hosts", ()):
        return None
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-TW,zh;q=0.9",
                **(headers or {}),
            })
            with _NET_SLOTS, urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
                raw = r.read().decode("utf-8", errors="replace")
            return raw if raw_text else json.loads(raw)
        except urllib.error.HTTPError as e:
            last = e
            if 400 <= e.code < 500:
                if e.code in (402, 429):
                    TC.warn("資料來源回應查詢次數已達上限（HTTP %d）。請稍後再試，或在進階設定填入 FinMind Token。" % e.code)
                elif e.code == 403:
                    TC.warn("%s 拒絕查詢（HTTP 403），可能暫時限制了查詢頻率，請過一段時間再試。" % host)
                break
            time.sleep(pause * (i + 1))
        except urllib.error.URLError as e:
            last = e
            if st is not None:
                st.setdefault("offline_hosts", []).append(host)
                st.setdefault("errors", {})[host] = describe_error(e)
                st["offline"] = True
                TC.warn("目前連不上 %s：%s。本次改用本機快取。" % (host, describe_error(e)))
            break
        except Exception as e:          # noqa: BLE001
            last = e
            time.sleep(pause * (i + 1))
    reason = describe_error(last) if last is not None else "未知原因"
    if st is not None:
        st.setdefault("errors", {})[host] = reason
    log("    ! 取得失敗 %s：%s" % (host, reason))
    return None


def to_float(x, default=None):
    if x is None:
        return default
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).replace(",", "").replace("+", "").strip()
    if s in ("", "-", "--", "---", "N/A", "null", "None"):
        return default
    try:
        return float(s)
    except ValueError:
        return default


def roc_to_iso(s):
    """'115/09/01' -> '2026-09-01'"""
    m = re.match(r"\s*(\d{2,3})/(\d{1,2})/(\d{1,2})", str(s))
    if not m:
        return None
    y, mo, d = int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))
    return "%04d-%02d-%02d" % (y, mo, d)


HISTORY_YEARS = 10          # 型態歷史勝率：往回抓幾年的日K（只抓股價，增量快取，之後每天只補新的一天）
KLINE_MAX = 250             # 主K線圖最長可切換的區間（交易日）
KLINE_RANGES = (60, 120, 250)
DEMO_HISTORY = 2500         # 示範資料的歷史長度（約 10 年）


def history_calendar_days(display_days):
    """顯示 N 個交易日，要往回抓多少「日曆天」。

    多抓 100 個交易日當暖身，MA60 / MACD / RSI 才算得出來；
    交易日約佔日曆天的 2/3，再多留一點緩衝。
    """
    return int((max(int(display_days), 5) + 100) * 1.6) + 30


def month_starts(start, end):
    """回傳涵蓋 [start, end] 的每個月 1 號 (date 物件)。"""
    out, cur = [], _dt.date(start.year, start.month, 1)
    while cur <= end:
        out.append(cur)
        cur = _dt.date(cur.year + 1, 1, 1) if cur.month == 12 else _dt.date(cur.year, cur.month + 1, 1)
    return out


# --------------------------------------------------------------------------
# 技術指標  (全部純 Python，輸入 list，輸出等長 list，前段不足補 None)
# --------------------------------------------------------------------------

def sma(vals, n):
    out, acc, q = [], 0.0, []
    for v in vals:
        if v is None:
            out.append(None)
            continue
        q.append(v)
        acc += v
        if len(q) > n:
            acc -= q.pop(0)
        out.append(acc / n if len(q) == n else None)
    return out


def ema(vals, n):
    out, prev, k = [], None, 2.0 / (n + 1)
    seed, acc = [], 0.0
    for v in vals:
        if v is None:
            out.append(None)
            continue
        if prev is None:
            seed.append(v)
            acc += v
            if len(seed) < n:
                out.append(None)
                continue
            prev = acc / n
            out.append(prev)
            continue
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def kdj(high, low, close, n=9, k_period=3, d_period=3):
    """台股慣用 KD(9,3,3)，K/D 平滑係數 1/3。"""
    K, D = [], []
    pk, pd = 50.0, 50.0
    for i in range(len(close)):
        if i < n - 1:
            K.append(None)
            D.append(None)
            continue
        hh = max(high[i - n + 1:i + 1])
        ll = min(low[i - n + 1:i + 1])
        rsv = 50.0 if hh == ll else (close[i] - ll) / (hh - ll) * 100.0
        pk = pk * (1 - 1.0 / k_period) + rsv * (1.0 / k_period)
        pd = pd * (1 - 1.0 / d_period) + pk * (1.0 / d_period)
        K.append(pk)
        D.append(pd)
    return K, D


def macd(close, fast=12, slow=26, signal=9):
    ef, es = ema(close, fast), ema(close, slow)
    dif = [None if (a is None or b is None) else a - b for a, b in zip(ef, es)]
    sig = ema([d for d in dif], signal)
    osc = [None if (a is None or b is None) else a - b for a, b in zip(dif, sig)]
    return dif, sig, osc


def rsi(close, n=14):
    """Wilder 平滑。"""
    out = [None] * len(close)
    if len(close) <= n:
        return out
    gains = losses = 0.0
    for i in range(1, n + 1):
        ch = close[i] - close[i - 1]
        gains += max(ch, 0.0)
        losses += max(-ch, 0.0)
    ag, al = gains / n, losses / n
    out[n] = (50.0 if ag == 0 else 100.0) if al == 0 else 100.0 - 100.0 / (1 + ag / al)
    for i in range(n + 1, len(close)):
        ch = close[i] - close[i - 1]
        ag = (ag * (n - 1) + max(ch, 0.0)) / n
        al = (al * (n - 1) + max(-ch, 0.0)) / n
        out[i] = (50.0 if ag == 0 else 100.0) if al == 0 else 100.0 - 100.0 / (1 + ag / al)
    return out


def atr(high, low, close, n=14):
    out = [None] * len(close)
    if len(close) <= n:
        return out
    tr = [high[0] - low[0]]
    for i in range(1, len(close)):
        tr.append(max(high[i] - low[i],
                      abs(high[i] - close[i - 1]),
                      abs(low[i] - close[i - 1])))
    prev = sum(tr[1:n + 1]) / n
    out[n] = prev
    for i in range(n + 1, len(close)):
        prev = (prev * (n - 1) + tr[i]) / n
        out[i] = prev
    return out


def dmi(high, low, close, n=14):
    """Wilder DMI/ADX; first DI at n, first ADX at 2*n-1; invalid bars restart warmup."""
    if n < 2 or not len(high) == len(low) == len(close):
        raise ValueError("DMI 輸入長度或週期無效")
    out = {k: [None] * len(close) for k in ("plus_di", "minus_di", "adx")}
    prev = None
    tr_sum = plus_sum = minus_sum = 0.0
    count = 0
    seeds = []
    last_adx = None
    for i, (h, l, c) in enumerate(zip(high, low, close)):
        if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0 for v in (h,l,c)) or not l <= c <= h:
            prev = None; count = 0; tr_sum = plus_sum = minus_sum = 0.0; seeds = []; last_adx = None
            continue
        if prev is None:
            prev = (h,l,c); continue
        ph,pl,pc = prev
        tr = max(h-l, abs(h-pc), abs(l-pc))
        up, down = h-ph, pl-l
        plus = up if up > 0 and up > down else 0.0
        minus = down if down > 0 and down > up else 0.0
        count += 1
        if count <= n:
            tr_sum += tr; plus_sum += plus; minus_sum += minus
        else:
            tr_sum = tr_sum - tr_sum/n + tr
            plus_sum = plus_sum - plus_sum/n + plus
            minus_sum = minus_sum - minus_sum/n + minus
        prev = (h,l,c)
        if count < n: continue
        pdi = 100*plus_sum/tr_sum if tr_sum else 0.0
        mdi = 100*minus_sum/tr_sum if tr_sum else 0.0
        dx = 100*abs(pdi-mdi)/(pdi+mdi) if pdi+mdi else 0.0
        out["plus_di"][i],out["minus_di"][i] = pdi,mdi
        if last_adx is None:
            seeds.append(dx)
            if len(seeds) == n: last_adx = sum(seeds)/n
        else:
            last_adx = (last_adx*(n-1)+dx)/n
        out["adx"][i] = last_adx
    return out


def volume_assessment(close, previous, volume, average):
    """Activity is non-directional; only directional price-volume score enters the total."""
    if average is None or average <= 0 or volume is None or volume <= 0 or previous is None or previous <= 0:
        return {"activity": None, "score": None, "state": "資料不足"}
    ratio = volume / average
    activity = 85.0 if ratio >= 2 else 72.0 if ratio >= 1.3 else 58.0 if ratio >= .8 else 42.0 if ratio >= .5 else 28.0
    direction = 1 if close > previous else -1 if close < previous else 0
    score = 50 + direction * 35 * min(ratio / 2, 1)
    state = ("放量" if ratio >= 1.3 else "縮量" if ratio < .8 else "平量") + ("上漲" if direction > 0 else "下跌" if direction < 0 else "平盤")
    return {"activity": activity, "score": score, "state": state}


def vwap(close, high, low, vol, n=20):
    """以典型價 (H+L+C)/3 加權的 n 日成交均價。"""
    out = []
    for i in range(len(close)):
        if i < n - 1:
            out.append(None)
            continue
        pv = sum(((high[j] + low[j] + close[j]) / 3.0) * vol[j] for j in range(i - n + 1, i + 1))
        vv = sum(vol[j] for j in range(i - n + 1, i + 1))
        out.append(pv / vv if vv else None)
    return out


FIB_RATIOS = (0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0)


def fibonacci(date, high, low, close, start=0):
    """費波南希回撤：取 [start, 最後一日] 區間內的波段高低點，算出各回撤價位。

    * 低點在前、高點在後＝上升波段：0% 在高點、100% 在低點，回撤是「從高點往下折返」。
    * 高點在前、低點在後＝下跌波段：0% 在低點、100% 在高點，回撤是「從低點往上反彈」。
    * 同價的極值取最近一次；高低點落在同一根 K 棒或區間內沒有價差時無法判定方向，回傳 available=False。
    * 只用到區間內已經發生的資料。0.5 不是費波南希數列的比率，是慣例上一起畫的中點。
    """
    n = len(close)
    idx = [i for i in range(max(0, start), n) if high[i] is not None and low[i] is not None]
    if len(idx) < 5:
        return {"available": False, "reason": "區間內有效交易日不足 5 日"}
    top = max(high[i] for i in idx)
    bottom = min(low[i] for i in idx)
    i_hi = max(i for i in idx if high[i] == top)
    i_lo = max(i for i in idx if low[i] == bottom)
    if top <= bottom:
        return {"available": False, "reason": "區間內沒有價差"}
    if i_hi == i_lo:
        return {"available": False, "reason": "高低點落在同一個交易日，無法判定波段方向"}
    up = i_lo < i_hi
    span = top - bottom
    levels = [{"ratio": r, "label": "%g%%" % round(r * 100, 1),
               "price": r2(top - span * r if up else bottom + span * r)} for r in FIB_RATIOS]
    c = close[n - 1]
    retraced = ((top - c) if up else (c - bottom)) / span * 100.0
    tol = max(span * 0.002, 1e-9)                    # 和某一條線的距離小於波段的 0.2% 視為「就在線上」
    at = next((lv for lv in levels if abs(lv["price"] - c) <= tol), None)
    above = [lv for lv in levels if lv["price"] > c + tol]
    below = [lv for lv in levels if lv["price"] < c - tol]
    near_up = min(above, key=lambda lv: lv["price"]) if above else None
    near_down = max(below, key=lambda lv: lv["price"]) if below else None

    def gap(lv):
        return None if lv is None else dict(lv, distance_pct=r2((lv["price"] - c) / c * 100.0))
    latest = max(i_hi, i_lo)
    return {"available": True, "direction": "up" if up else "down",
            "window_days": n - max(0, start), "from": date[idx[0]], "to": date[n - 1],
            "high": {"price": r2(top), "date": date[i_hi]}, "low": {"price": r2(bottom), "date": date[i_lo]},
            "levels": levels, "close": r2(c), "retraced_pct": r2(retraced, 1),
            "at": at, "above": gap(near_up), "below": gap(near_down),
            "bars_since_swing_end": (n - 1) - latest, "extending": latest == n - 1}


def bollinger(close, n=20, multiplier=2.0, rank_window=120):
    """SMA ± k × 母體標準差；%B 保留越界值，120日寬度百分位只用截至當日的資料。"""
    if n < 2 or multiplier <= 0 or rank_window < 2:
        raise ValueError("Invalid Bollinger parameters")
    result = {key: [None] * len(close) for key in
              ("mid", "upper", "lower", "percent_b", "width", "width_rank", "squeeze", "break_up", "break_down")}
    for i in range(n - 1, len(close)):
        window = close[i - n + 1:i + 1]
        if any(v is None or not math.isfinite(v) for v in window):
            continue
        mid = sum(window) / n
        sd = math.sqrt(sum((v - mid) ** 2 for v in window) / n)
        upper, lower = mid + multiplier * sd, mid - multiplier * sd
        result["mid"][i], result["upper"][i], result["lower"][i] = mid, upper, lower
        result["width"][i] = (upper - lower) / mid * 100 if mid > 0 else None
        result["percent_b"][i] = (close[i] - lower) / (upper - lower) if upper > lower else None
        if i and result["upper"][i - 1] is not None:
            result["break_up"][i] = close[i] > upper and close[i - 1] <= result["upper"][i - 1]
            result["break_down"][i] = close[i] < lower and close[i - 1] >= result["lower"][i - 1]
        history = result["width"][max(0, i - rank_window + 1):i + 1]
        if len(history) == rank_window and all(v is not None for v in history):
            # ties use midrank: a permanently flat width is not always classified as a new squeeze.
            value = result["width"][i]
            rank = (sum(v < value for v in history) + .5 * sum(v == value for v in history)) / rank_window * 100
            result["width_rank"][i] = rank
            result["squeeze"][i] = rank <= 20
    return result


def last_valid(seq, default=None):
    for v in reversed(seq):
        if v is not None:
            return v
    return default


def pct_rank(value, lo, hi):
    if lo is None or hi is None or hi <= lo:
        return None
    return max(0.0, min(100.0, (value - lo) / (hi - lo) * 100.0))


def clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


def r2(v, nd=2):
    return None if v is None else round(v, nd)


# --------------------------------------------------------------------------
# 資料來源 A：FinMind
# --------------------------------------------------------------------------

FINMIND = "https://api.finmindtrade.com/api/v4/data"
TWSE_DAY = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY"
TWSE_T86 = "https://www.twse.com.tw/rwd/zh/fund/T86"
TWSE_MARGIN = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN"

DEFAULT_ENDPOINTS = {
    "finmind": FINMIND,
    "twse_day": TWSE_DAY,
    "twse_t86": TWSE_T86,
    "twse_margin": TWSE_MARGIN,
    "stooq": "https://stooq.com/q/d/l/",     # 國際指數備援（CSV，免 Token）
    "yahoo": "https://query2.finance.yahoo.com/v8/finance/chart/",   # 選用備援（非官方，預設關閉）
}


def endpoints(override=None):
    """合併使用者自訂的 API 網址；空字串視為沿用預設。只接受 http/https。"""
    ep = dict(DEFAULT_ENDPOINTS)
    for k, v in (override or {}).items():
        v = (v or "").strip()
        if k in ep and v:
            if not v.lower().startswith(("http://", "https://")):
                raise ValueError("API 網址必須以 http:// 或 https:// 開頭：%s" % k)
            ep[k] = v
    return ep


def fm(dataset, data_id, start, end, token, ep=None, required_dates=None):
    ep = ep or DEFAULT_ENDPOINTS
    headers = {"Authorization": "Bearer " + token} if token else {}
    # 資料內容和 Token 無關，鍵裡不放 Token：之後才填 Token 也不必整批重抓。
    # 舊版（v1）把 Token 算進鍵裡，這裡把匿名與目前 Token 兩種舊鍵的資料併過來沿用。
    key = TC.key_for("finmind-v2", ep["finmind"], dataset, data_id)
    TC.adopt(key, {TC.key_for("finmind-v1", ep["finmind"], dataset, data_id, t) for t in ("", token)})
    def fetch(first, last):
        p = {"dataset": dataset, "data_id": data_id, "start_date": first, "end_date": last}
        j = http_get_json(ep["finmind"], p, headers=headers)
        if not j or j.get("status") not in (200, "200"):
            return None
        return j.get("data") if isinstance(j.get("data"), list) else None
    if dataset == "TaiwanStockInfo":
        return TC.response(key, lambda: fetch(start,end), lambda data: isinstance(data,list) and bool(data), 86400)
    if dataset == "TaiwanStockDividendResult":
        # 舊月鍵沒有涵蓋起迄資訊，不沿用；逐日記錄已確認空值，擴大範圍只補缺日。
        key = TC.key_for("finmind-dividend-v3", ep["finmind"], dataset, data_id)
        return TC.range_data(key, start, end, fetch, max_age=86400, require_complete=True, recent_ttl=86400)
    return TC.range_data(key, start, end, fetch, required_dates=required_dates)



def _finmind_bars(rows):
    bars = []
    for r in rows or []:
        c = to_float(r.get("close"))
        if c is None or c <= 0 or not isinstance(r.get("date"), str):
            continue
        bars.append({
            "date": r["date"],
            "open": to_float(r.get("open"), c),
            "high": to_float(r.get("max"), c),
            "low": to_float(r.get("min"), c),
            "close": c,
            "vol": to_float(r.get("Trading_Volume"), 0) / 1000.0,   # 股 -> 張
            "amount": to_float(r.get("Trading_money"), 0),
            "trades": to_float(r.get("Trading_turnover"), 0),
        })
    bars.sort(key=lambda b: b["date"])
    return bars


def fetch_finmind(code, start, end, token, ep=None):
    """FinMind：各資料集互不相依，分兩批平行抓（股價＋基本資料 → 法人／融資券／除權息／大盤）。"""
    ep = ep or DEFAULT_ENDPOINTS

    def get_price():
        TC.report(detail="檢查歷史資料與缺少日期")
        return fm("TaiwanStockPrice", code, start, end, token, ep)

    def get_info():
        TC.report(detail="讀取股票基本資訊")
        return fm("TaiwanStockInfo", code, start, end, token, ep)

    TC.report("股價", "檢查歷史資料與缺少日期")
    price, info = TC.parallel([("股價", get_price), ("股票名稱", get_info)])
    if not price:
        return None
    bars = _finmind_bars(price)
    bar_dates = [b["date"] for b in bars]

    name = code
    market = None
    matches = [r for r in (info or []) if r.get("stock_id") == code]
    if matches:
        row = max(matches, key=lambda r: str(r.get("date") or ""))
        name = row.get("stock_name") or code
        market = str(row.get("type", "")).lower() or None
    # 與未還原個股同採價格報酬；不可混用含息報酬指數。
    bench_id = {"twse": "TAIEX", "tpex": "TPEx"}.get(market)

    def get_inst():
        TC.report(detail="檢查歷史資料與缺少日期")
        return fm("TaiwanStockInstitutionalInvestorsBuySell", code, start, end, token, ep,
                  required_dates=bar_dates) or []

    def get_margin():
        TC.report(detail="檢查歷史資料與缺少日期")
        return fm("TaiwanStockMarginPurchaseShortSale", code, start, end, token, ep,
                  required_dates=bar_dates) or []

    def get_dividends():
        # 除權息日：均線、KD、支撐壓力在除權息後會出現「假缺口」，至少要讓使用者看得到是哪一天。
        TC.report(detail="查詢區間內的除權息日")
        return fm("TaiwanStockDividendResult", code, start, end, token, ep)

    def get_history():
        # 型態歷史勝率用：同一個快取鍵，只會補抓分析區間以前、還沒存過的日期（第一次一個請求，之後幾乎不用連網）。
        first = (_dt.date.fromisoformat(end) - _dt.timedelta(days=int(HISTORY_YEARS * 365.25))).isoformat()
        if first >= start:
            return None
        TC.report(detail="近 %d 年日K（K 線型態歷史統計）" % HISTORY_YEARS)
        return fm("TaiwanStockPrice", code, first, end, token, ep)

    def get_bench():
        if not bench_id:
            TC.warn("大盤基準：市場別未確認或不支援，暫不計算相對強弱。")
            return []
        TC.report(detail="讀取同口徑價格指數")
        return fm("TaiwanStockPrice", bench_id, start, end, token, ep, required_dates=bar_dates) or []

    TC.report("三大法人／融資融券／除權息／大盤基準", "五個資料集同時讀取")
    inst, mg, dividend_rows, bench_rows, history_rows = TC.parallel([
        ("三大法人", get_inst), ("融資融券", get_margin), ("除權息", get_dividends), ("大盤基準", get_bench),
        ("歷史股價", get_history)])
    history = _finmind_bars(history_rows) if history_rows else None

    chips = {}
    for r in inst:
        d = r["date"]
        nm = r.get("name", "")
        key = ("foreign" if nm.startswith(("Foreign_Investor", "Foreign_Dealer")) else
               "trust" if nm.startswith("Investment_Trust") else
               "dealer" if nm.startswith("Dealer") else None)
        if key is None:
            continue
        buy, sell = to_float(r.get("buy")), to_float(r.get("sell"))
        slot = chips.setdefault(d, {"foreign": None, "trust": None, "dealer": None})
        if buy is not None and sell is not None:
            slot[key] = (slot[key] or 0.0) + (buy - sell) / 1000.0

    margin = {}
    for r in mg:
        margin[r["date"]] = {
            "margin_bal": to_float(r.get("MarginPurchaseTodayBalance")),
            "margin_prev": to_float(r.get("MarginPurchaseYesterdayBalance")),
            "short_bal": to_float(r.get("ShortSaleTodayBalance")),
            "short_prev": to_float(r.get("ShortSaleYesterdayBalance")),
        }

    # 除權息的警示都以「除權息：」開頭（平行抓取時其他資料集的警示不算在內）。
    dividend_status = "unavailable" if dividend_rows is None else "confirmed"
    if dividend_rows is not None and any(str(w).startswith("除權息") for w in (TC.state() or {}).get("warnings", [])):
        dividend_status = "partial"
    dividends = []
    for r in dividend_rows or []:
        # 只收真的像除權息結果的列（來源回傳別種格式時寧可當作沒有，也不要亂標）
        if (isinstance(r, dict) and isinstance(r.get("date"), str)
                and ("stock_or_cache_dividend" in r or "stock_and_cache_dividend" in r)):
            dividends.append({"date": r["date"],
                              "kind": str(r.get("stock_or_cache_dividend") or "除權息"),
                              "amount": to_float(r.get("stock_and_cache_dividend")),
                              "before": to_float(r.get("before_price")),
                              "reference": to_float(r.get("reference_price"))})
        else:
            dividend_status = "partial"
            TC.warn("除權息：來源欄位格式不完整，無法確認所有事件。")

    bench = {}
    for r in bench_rows:
        value = to_float(r.get("close"))
        if value and value > 0 and r.get("stock_id") == bench_id:
            bench[r["date"]] = value
    return {"bars": bars, "chips": chips, "margin": margin, "history": history,
            "name": name, "source": "FinMind", "market": market,
            "dividends": dividends if dividend_rows is not None else None,
            "dividend_status": dividend_status,
            "bench": {"id": bench_id, "name": "櫃買價格指數" if market == "tpex" else "加權價格指數",
                      "basis": "price", "series": bench} if bench else None}



# --------------------------------------------------------------------------
# 資料來源 B：證交所 TWSE 官方
# --------------------------------------------------------------------------

def _compact_t86(j):
    """T86 全市場單日（約一千多檔 × 19 欄）→ 每檔只留 [外資, 投信, 自營商]（單位：張）。"""
    rows = {}
    for row in j.get("data", []) or []:
        nums = [to_float(x) for x in row[2:]]
        total = nums[-1] / 1000.0 if nums and nums[-1] is not None else None      # 末欄：三大法人買賣超股數
        fo = ((nums[2] + nums[5]) / 1000.0
              if len(nums) > 6 and nums[2] is not None and nums[5] is not None else None)
        tr = nums[8] / 1000.0 if len(nums) > 8 and nums[8] is not None else None
        dealer = total - fo - tr if all(v is not None for v in (total, fo, tr)) else None
        rows[str(row[0]).strip()] = [fo, tr, dealer]
    return {"stat": "OK", "compact": 1, "rows": rows}


def _compact_margin(j):
    """MI_MARGN 全市場單日 → 每檔只留 [融資今日, 融資前日, 融券今日, 融券前日]（單位：張）。"""
    src = []
    for t in j.get("tables") or []:
        src.extend(t.get("data", []) or [])
    if not src:
        src = j.get("data", []) or []
    rows = {}
    for row in src:
        if len(row) > 12:
            rows[str(row[0]).strip()] = [to_float(row[6]), to_float(row[5]), to_float(row[12]), to_float(row[11])]
    return {"stat": "OK", "compact": 1, "rows": rows}


def twse_json(url, params, final_day, compact=None):
    age = None if final_day < TC.today()-_dt.timedelta(days=TC.RECENT_DAYS) else TC.TTL
    valid = lambda j: isinstance(j,dict) and j.get("stat")=="OK"
    if compact is None:
        return TC.response(TC.key_for("twse-v1",url,params), lambda: http_get_json(url,params), valid, age)
    return TC.response(TC.key_for("twse-v2",url,params), lambda: http_get_json(url,params), valid, age,
                       transform=compact, kind="market-day", legacy_key=TC.key_for("twse-v1",url,params))


def fetch_twse(code, start, end, throttle=0.35, chip_days=60, ep=None):
    ep = ep or DEFAULT_ENDPOINTS
    s = _dt.date.fromisoformat(start)
    e = _dt.date.fromisoformat(end)

    bars, name = [], code
    months = month_starts(s, e)
    for index,m in enumerate(months):
        TC.report("股價", "%s（%d/%d 月）" % (m.strftime("%Y-%m"),index+1,len(months)))
        next_month = (m.replace(day=28)+_dt.timedelta(days=4)).replace(day=1)
        before = (TC.state() or {}).get("network_requests",0)
        j = twse_json(ep["twse_day"], {"date": m.strftime("%Y%m%d"),
                                     "stockNo": code, "response": "json"}, next_month-_dt.timedelta(days=1))
        if not TC.state() or TC.state()["network_requests"] > before:
            time.sleep(throttle)
        if not j or j.get("stat") != "OK":
            continue
        t = j.get("title", "")
        mm = re.search(r"\d{2,3}年\d{1,2}月\s*(\d{4,6})\s*(\S+)", t)
        if mm:
            name = mm.group(2)
        for row in j.get("data", []):
            d = roc_to_iso(row[0])
            c = to_float(row[6])
            if not d or c is None or not (start <= d <= end):
                continue
            bars.append({
                "date": d,
                "open": to_float(row[3], c), "high": to_float(row[4], c),
                "low": to_float(row[5], c), "close": c,
                "vol": (to_float(row[1], 0) or 0) / 1000.0,
                "amount": to_float(row[2], 0) or 0,
                "trades": to_float(row[8], 0) or 0,
            })
    if not bars:
        return None
    bars.sort(key=lambda b: b["date"])
    dates = [b["date"] for b in bars]

    # 法人與融資券：逐日抓，只抓有交易的日子
    chips, margin = {}, {}
    days = dates[-max(5, min(60, int(chip_days))):]
    log("    · 證交所法人/融資券逐日抓取 %d 天…" % len(days))
    for index,d in enumerate(days):
        ymd = d.replace("-", "")
        TC.report("三大法人", "%s（%d/%d 日）" % (d,index+1,len(days)))
        before = (TC.state() or {}).get("network_requests",0)
        j = twse_json(ep["twse_t86"], {"date": ymd, "selectType": "ALL", "response": "json"},
                      _dt.date.fromisoformat(d), compact=_compact_t86)
        if not TC.state() or TC.state()["network_requests"] > before:
            time.sleep(throttle)
        v = (j or {}).get("rows", {}).get(code) if j and j.get("stat") == "OK" else None
        if v:
            chips[d] = {"foreign": v[0], "trust": v[1], "dealer": v[2]}
        TC.report("融資融券", "%s（%d/%d 日）" % (d,index+1,len(days)))
        before = (TC.state() or {}).get("network_requests",0)
        j = twse_json(ep["twse_margin"], {"date": ymd, "selectType": "ALL", "response": "json"},
                      _dt.date.fromisoformat(d), compact=_compact_margin)
        if not TC.state() or TC.state()["network_requests"] > before:
            time.sleep(throttle)
        v = (j or {}).get("rows", {}).get(code) if j and j.get("stat") == "OK" else None
        if v:
            margin[d] = {"margin_bal": v[0], "margin_prev": v[1], "short_bal": v[2], "short_prev": v[3]}
    return {"bars": bars, "chips": chips, "margin": margin,
            "name": name, "source": "TWSE 證交所"}


# --------------------------------------------------------------------------
# 資料來源 C：合成資料 (離線測試版型用)
# --------------------------------------------------------------------------

def _demo_history(bars, count, seed):
    """示範資料往前延伸的歷史（型態統計用）：從第一根往回推，含隔夜跳空；不改動原本的 bars。"""
    rnd = random.Random(seed)
    out = []
    first = bars[0]
    close = first["open"]                  # 前一天的收盤＝第一根的開盤（原本的合成規則）
    base = close
    d = _dt.date.fromisoformat(first["date"])
    while len(out) < count:
        d -= _dt.timedelta(days=1)
        if d.weekday() >= 5:
            continue
        shock = rnd.gauss(0, 0.019) - 0.004 * math.log(base / close)   # 往回推時慢慢拉回起始價附近
        c = close
        o = max(1.0, close / (1 + shock))
        h = max(o, c) * (1 + abs(rnd.gauss(0, 0.008)))
        l = min(o, c) * (1 - abs(rnd.gauss(0, 0.008)))
        v = max(80.0, rnd.lognormvariate(8.4, 0.55))
        out.append({"date": d.isoformat(), "open": round(o, 2), "high": round(h, 2), "low": round(l, 2),
                    "close": round(c, 2), "vol": round(v, 3), "amount": round(v * 1000 * c, 0),
                    "trades": int(v * rnd.uniform(0.8, 2.4))})
        close = o * (1 + rnd.gauss(0, 0.004))   # 再前一天的收盤：與這天開盤之間留一點跳空
    out.reverse()
    return out + bars


def fetch_demo(code, days=220, seed=None, history_days=0):
    # 用 crc32 當預設種子：原本用字元碼加總，2330 與 2303 這種同字元的代號會產生一模一樣的序列。
    rnd = random.Random(seed if seed is not None else zlib.crc32(code.encode("utf-8")))
    px = 300.0 + rnd.random() * 400
    bars, chips, margin = [], {}, {}
    d = _dt.date.today() - _dt.timedelta(days=int(days * 1.45))
    drift = rnd.uniform(-0.0012, 0.0028)
    mbal, sbal = rnd.uniform(8000, 40000), rnd.uniform(200, 1500)
    while len(bars) < days:
        d += _dt.timedelta(days=1)
        if d.weekday() >= 5:
            continue
        shock = rnd.gauss(drift, 0.021)
        o = px
        c = max(1.0, px * (1 + shock))
        h = max(o, c) * (1 + abs(rnd.gauss(0, 0.008)))
        l = min(o, c) * (1 - abs(rnd.gauss(0, 0.008)))
        v = max(80.0, rnd.lognormvariate(8.4, 0.55) / 1000.0 * 1000)
        iso = d.isoformat()
        bars.append({"date": iso, "open": round(o, 2), "high": round(h, 2),
                     "low": round(l, 2), "close": round(c, 2),
                     "vol": round(v, 3), "amount": round(v * 1000 * c, 0),
                     "trades": int(v * rnd.uniform(0.8, 2.4))})
        chips[iso] = {"foreign": round(rnd.gauss(0, 900), 2),
                      "trust": round(rnd.gauss(60, 420), 2),
                      "dealer": round(rnd.gauss(0, 160), 2)}
        mbal = max(100.0, mbal + rnd.gauss(0, 260))
        sbal = max(0.0, sbal + rnd.gauss(0, 40))
        margin[iso] = {"margin_bal": round(mbal, 0), "margin_prev": round(mbal, 0),
                       "short_bal": round(sbal, 0), "short_prev": round(sbal, 0)}
        px = c
    # 合成的大盤與一筆除息事件，讓相對強弱與除權息標記在示範模式也看得到。
    # 用獨立的亂數產生器，不影響上面價量序列（既有測試依賴固定種子的結果）。
    rnd2 = random.Random((seed if seed is not None else zlib.crc32(code.encode("utf-8"))) + 99991)
    level, bench = 20000.0, {}
    for b in bars:
        level *= 1 + rnd2.gauss(0.0006, 0.009)
        bench[b["date"]] = round(level, 2)
    ex = bars[-12]
    history = None
    if history_days and history_days > len(bars):
        history = _demo_history(bars, history_days - len(bars),
                                (seed if seed is not None else zlib.crc32(code.encode("utf-8"))) + 424242)
    return {"bars": bars, "chips": chips, "margin": margin, "history": history,
            "name": "測試樣本", "source": "合成資料（非真實行情）", "market": "twse",
            "dividends": [{"date": ex["date"], "kind": "除息", "amount": round(ex["close"] * 0.012, 2),
                           "before": ex["close"], "reference": round(ex["close"] * 0.988, 2)}],
            "bench": {"id": "TAIEX", "name": "加權價格指數（合成）", "basis": "price", "series": bench}}


# --------------------------------------------------------------------------
# 分析：把原始資料算成儀表板要的所有數字
# --------------------------------------------------------------------------

def merged_history(raw, bars):
    """長歷史（型態統計用）＋分析用的 bars；同一天以 bars 為準，確保兩者最後幾根完全一致。"""
    hist = raw.get("history") or []
    if not hist:
        return list(bars)
    by = {b["date"]: b for b in hist if isinstance(b, dict) and b.get("close")}
    by.update({b["date"]: b for b in bars})
    last = bars[-1]["date"] if bars else None
    return [by[d] for d in sorted(by) if last is None or d <= last]


def extended_kline(raw, bars, window):
    """主K線圖（0928a）：可切換 60／120／250 日與分析天數；均線、布林在完整歷史上計算，前段不會空白。
    型態與缺口在最長歷史（最多 10 年）上偵測與統計，畫面只收到最後 KLINE_MAX 根內的標記。"""
    hist = merged_history(raw, bars)
    n = len(hist)
    if n < 2:
        return None, None
    d = [b["date"] for b in hist]
    o = [b["open"] for b in hist]
    h = [b["high"] for b in hist]
    l = [b["low"] for b in hist]
    c = [b["close"] for b in hist]
    v = [b["vol"] for b in hist]
    size = min(n, max(KLINE_MAX, window))
    k0 = n - size
    ranges = sorted({min(window, size)} | {r for r in KLINE_RANGES if r <= size} | ({size} if size < KLINE_MAX else set()))
    bb = bollinger(c)
    cut = lambda a, nd=2: [r2(x, nd) for x in a[k0:]]
    kline = {
        "date": d[k0:], "open": cut(o), "high": cut(h), "low": cut(l), "close": cut(c), "vol": cut(v, 3),
        "ma5": cut(sma(c, 5)), "ma10": cut(sma(c, 10)), "ma20": cut(sma(c, 20)), "ma60": cut(sma(c, 60)),
        "bb_upper": cut(bb["upper"], 6), "bb_mid": cut(bb["mid"], 6), "bb_lower": cut(bb["lower"], 6),
        "bb_percent_b": cut(bb["percent_b"], 6), "bb_width": cut(bb["width"], 6),
        "ranges": ranges, "window": min(window, size),
        "fib": {str(r): fibonacci(d, h, l, c, n - r) for r in ranges},
        "history_bars": n, "history_from": d[0],
    }
    return kline, TP.analyse(d, o, h, l, c, size)


def analyse(code, raw, days):
    """指標一律在「完整取得的歷史」上計算，再切出要顯示的最後 days 天。

    這樣即使只想看 30 天，MA60 / MACD / RSI 也都是暖身過的正確值，
    而不是因為視窗太短而算不出來。
    """
    allb = raw["bars"]
    if len(allb) < 30:
        raise ValueError("%s 有效交易日只有 %d 筆，不足以計算（至少需 30 筆）" % (code, len(allb)))

    date = [b["date"] for b in allb]
    op = [b["open"] for b in allb]
    hi = [b["high"] for b in allb]
    lo = [b["low"] for b in allb]
    cl = [b["close"] for b in allb]
    vo = [b["vol"] for b in allb]

    N = len(cl)
    ma5, ma10, ma20, ma60 = sma(cl, 5), sma(cl, 10), sma(cl, 20), sma(cl, 60)
    vma20 = sma(vo, 20)
    K, D = kdj(hi, lo, cl)
    dif, sig, osc = macd(cl)
    rsi14 = rsi(cl, 14)
    atr14 = atr(hi, lo, cl, 14)
    vw20 = vwap(cl, hi, lo, vo, 20)
    bb = bollinger(cl)
    directional = dmi(hi, lo, cl)

    last = N - 1
    W = max(2, min(days, N))          # 顯示視窗長度
    w0 = N - W                        # 顯示視窗起點
    cut = lambda a: a[w0:]

    c = cl[last]
    prev_c = cl[last - 1]
    chg = c - prev_c
    chg_pct = chg / prev_c * 100.0 if prev_c else 0.0

    # 支撐／壓力與位階固定看 60 日與 20 日，不受顯示視窗影響
    win = min(60, N)
    w_hi, w_lo = max(hi[-win:]), min(lo[-win:])
    support, resistance = w_lo, w_hi

    m20 = ma20[last]
    bias20 = (c - m20) / m20 * 100.0 if m20 else None
    a = atr14[last]
    atr_pct = (a / c * 100.0) if a else None
    vratio = (vo[last] / vma20[last]) if vma20[last] else None
    pos20 = pct_rank(c, min(lo[-20:]), max(hi[-20:]))
    pos60 = pct_rank(c, w_lo, w_hi)

    # 日期以價格交易日為準；缺漏不往更早日期補齊，也不當作零。
    chips = raw.get("chips") or {}
    def chip_row(d):
        values = chips.get(d) or {}
        row = {k: values.get(k) for k in ("foreign", "trust", "dealer")}
        row["date"] = d
        row["total"] = (sum(row[k] for k in ("foreign", "trust", "dealer"))
                        if all(row[k] is not None for k in ("foreign", "trust", "dealer")) else None)
        return row
    all_chip_rows = [chip_row(d) for d in date]
    chip_rows = cut(all_chip_rows)
    full_chip = [r for r in all_chip_rows if r["date"] in chips]
    coverage5 = sum(r["total"] is not None for r in all_chip_rows[-5:])
    coverage20 = sum(r["total"] is not None for r in all_chip_rows[-20:])
    net5 = sum(r["total"] for r in all_chip_rows[-5:]) if coverage5 == 5 else None
    net20 = sum(r["total"] for r in all_chip_rows[-20:]) if coverage20 == 20 else None
    last_chip = full_chip[-1] if full_chip else None
    shown_chip_days = sum(r["total"] is not None for r in chip_rows)

    # ---- 融資券 ----
    margin = raw.get("margin") or {}
    mg_last = None
    for d in reversed(date):
        if d in margin:
            mg_last = dict(margin[d])
            mg_last["date"] = d
            break
    if mg_last:
        mg_last["margin_chg"] = (mg_last["margin_bal"] - mg_last["margin_prev"]
                                 if mg_last["margin_bal"] is not None and mg_last["margin_prev"] is not None else None)
        mg_last["short_chg"] = (mg_last["short_bal"] - mg_last["short_prev"]
                                if mg_last["short_bal"] is not None and mg_last["short_prev"] is not None else None)

    # ---- 規則計分 (0~100；純規則，非勝率) ----
    # 寫成「任一天 i 的分數」，今天的分數就是 i=last；回測時用同一套規則逐日重算，
    # 每一天只用到當天以前的資料，不偷看未來。
    def scores_at(i):
        ci = cl[i]

        def trend():
            pts, cap = 0.0, 0.0
            if ma5[i] and ma10[i] and ma20[i]:
                cap += 40
                if ma5[i] > ma10[i] > ma20[i]:
                    pts += 40
                elif ma5[i] > ma10[i]:
                    pts += 25
                elif ma5[i] < ma10[i] < ma20[i]:
                    pts += 5
                else:
                    pts += 15
            if ma20[i]:
                cap += 30
                pts += 30 if ci > ma20[i] else 8
            if ma60[i]:
                cap += 30
                pts += 30 if ci > ma60[i] else 8
            return clamp(pts / cap * 100) if cap else None

        def momentum():
            pts, cap = 0.0, 0.0
            if osc[i] is not None:
                cap += 40
                prev_osc = osc[i - 1] if i > 0 and osc[i - 1] is not None else osc[i]
                if osc[i] > 0 and osc[i] >= prev_osc:
                    pts += 40
                elif osc[i] > 0:
                    pts += 28
                elif osc[i] >= prev_osc:
                    pts += 18
                else:
                    pts += 6
            if rsi14[i] is not None:
                cap += 35
                r = rsi14[i]
                pts += 35 if 50 <= r <= 70 else (26 if 40 <= r < 50 else (20 if 70 < r <= 80 else 10))
            if K[i] is not None and D[i] is not None:
                cap += 25
                pts += 25 if K[i] > D[i] else 9
            return clamp(pts / cap * 100) if cap else None

        def chip():
            w5, w20 = all_chip_rows[max(0, i - 4):i + 1], all_chip_rows[max(0, i - 19):i + 1]
            if len(w5) < 5 or len(w20) < 20 or any(r["total"] is None for r in w20):
                return None
            n5, n20 = sum(r["total"] for r in w5), sum(r["total"] for r in w20)
            avg_vol = vma20[i] or (sum(vo[max(0, i - 19):i + 1]) / min(20, i + 1))
            base = 50.0
            if avg_vol:
                base += clamp(n5 / (avg_vol * 5) * 100, -35, 35)
                base += clamp(n20 / (avg_vol * 20) * 100, -15, 15)
            return clamp(base)

        def volume():
            return volume_assessment(cl[i], cl[i-1] if i else None, vo[i], vma20[i])["score"]

        st, sm, sc, sv = trend(), momentum(), chip(), volume()
        got = [(v, w) for v, w in [(st, 0.5), (sm, 0.5)] if v is not None]
        tech = clamp(sum(v * w for v, w in got) / sum(w for _, w in got)) if got else None
        got = [(v, w) for v, w in [(st, 0.32), (sm, 0.28), (sc, 0.25), (sv, 0.15)] if v is not None]
        ov = clamp(sum(v * w for v, w in got) / sum(w for _, w in got)) if got else None
        return st, sm, sc, sv, tech, ov

    s_trend, s_mom, s_chip, s_vol, tech_score, overall = scores_at(last)

    # ---- 規則分回測：過去每一天的綜合分，對照「之後 5／10 個交易日」的實際報酬 ----
    def backtest():
        horizons = (5, 10)
        buckets = [("72 分以上", 72, 101), ("58～72 分", 58, 72), ("42～58 分", 42, 58), ("未滿 42 分", -1, 42)]
        first = 60                                # MA60 暖身完成後才開始算
        hist = {i: scores_at(i)[5] for i in range(first, N)}

        def stat(idx, h):
            rets = [(cl[i + h] / cl[i] - 1) * 100.0 for i in idx if i + h < N and cl[i]]
            if not rets:
                return {"n": 0, "mean": None, "median": None, "win": None}
            srt = sorted(rets)
            mid = len(srt) // 2
            med = srt[mid] if len(srt) % 2 else (srt[mid - 1] + srt[mid]) / 2
            return {"n": len(rets), "mean": r2(sum(rets) / len(rets)), "median": r2(med),
                    "win": r2(sum(1 for x in rets if x > 0) / len(rets) * 100, 1)}

        scored = [i for i, v in hist.items() if v is not None]
        rows = []
        for label, lo_, hi_ in buckets:
            idx = [i for i in scored if lo_ <= hist[i] < hi_]
            rows.append(dict({"label": label, "days": len(idx)},
                             **{"h%d" % h: stat(idx, h) for h in horizons}))
        base = dict({"label": "全部交易日（基準）", "days": len(scored)},
                    **{"h%d" % h: stat(scored, h) for h in horizons})
        usable = base["h5"]["n"]
        top, bm = rows[0]["h5"], base["h5"]
        if usable < 60 or top["n"] < 10:
            finding = "樣本太少（高分日 %d 天、可統計 %d 天），這張表還看不出規則分有沒有用。" % (top["n"], usable)
        elif top["mean"] > bm["mean"] + 0.3 and top["win"] > bm["win"]:
            finding = ("這段期間，72 分以上的日子之後 5 日平均報酬 %+.2f%%，高於全部交易日的 %+.2f%%。"
                       "只是單一個股、目前取得區間的樣本，不代表之後也會如此。" % (top["mean"], bm["mean"]))
        elif top["mean"] < bm["mean"] - 0.3:
            finding = ("這段期間，72 分以上的日子之後 5 日平均報酬 %+.2f%%，反而低於全部交易日的 %+.2f%%。"
                       "高分描述的是「已經漲了一段」，在這檔股票上並不代表後續表現較好。" % (top["mean"], bm["mean"]))
        else:
            finding = ("這段期間，72 分以上的日子之後 5 日平均報酬 %+.2f%%，和全部交易日的 %+.2f%% 差不多，"
                       "看不出規則分有預測力。" % (top["mean"], bm["mean"]))
        return {"horizons": list(horizons), "rows": rows, "baseline": base, "finding": finding,
                "from": date[first] if N > first else None, "to": date[last],
                "enough": usable >= 60,
                "score_series": [r2(hist.get(i), 1) for i in range(w0, N)]}

    bt = backtest() if N > 75 else None

    # ---- 相對大盤強弱：同一段日期的個股報酬 − 指數報酬（百分點） ----
    def relative(n):
        b = (raw.get("bench") or {}).get("series") or {}
        if last - n < 0:
            return None
        d0, d1 = date[last - n], date[last]
        if d0 not in b or d1 not in b or not b[d0] or not cl[last - n]:
            return None
        stock = (cl[last] / cl[last - n] - 1) * 100.0
        index = (b[d1] / b[d0] - 1) * 100.0
        return {"stock": r2(stock), "index": r2(index), "rs": r2(stock - index)}
    rel20, rel60 = relative(20), relative(60)
    bench_info = None
    if raw.get("bench"):
        bench_info = {"id": raw["bench"]["id"], "name": raw["bench"]["name"],
                      "basis": raw["bench"].get("basis", "price"),
                      "latest": max(raw["bench"]["series"]) if raw["bench"]["series"] else None,
                      "d20": rel20, "d60": rel60}

    # ---- 除權息事件 ----
    divs = sorted(raw.get("dividends") or [], key=lambda x: x["date"])
    shown = set(date[w0:])
    events = [dict(x, in_view=x["date"] in shown) for x in divs if x["date"] >= date[max(0, last - 59)]]

    # ---- 交易參數（規則式，非建議） ----
    entry_lo = entry_hi = stop = target = rr = None
    if a:
        entry_lo, entry_hi = c - 0.25 * a, c + 0.25 * a
        stop = min(c - 1.0 * a, min(lo[-10:]))
        target = resistance
        if entry_hi > stop and target > entry_hi:
            rr = (target - entry_hi) / (entry_hi - stop)

    # ---- 結論燈號 ----
    near_top = (rr is not None and rr < 1) or (pos60 is not None and pos60 >= 92)
    if overall is None:
        verdict, vclass = "資料不足", "neutral"
    elif near_top and overall >= 58:
        verdict, vclass = "強勢但已近壓力．不追價", "mild"
    elif overall >= 72 and (s_chip is None or s_chip >= 50):
        verdict, vclass = "偏多．可留意回檔", "bull"
    elif overall >= 58:
        verdict, vclass = "中性偏多．不追價", "mild"
    elif overall >= 42:
        verdict, vclass = "中性．等待", "neutral"
    else:
        verdict, vclass = "偏空．觀望", "bear"

    if ma5[last] and ma10[last] and ma20[last]:
        if ma5[last] > ma10[last] > ma20[last]:
            trend_txt = "多頭排列"
        elif ma5[last] < ma10[last] < ma20[last]:
            trend_txt = "空頭排列"
        else:
            trend_txt = "糾結"
    else:
        trend_txt = "無資料"

    if K[last] is None:
        kd_txt = "無資料"
    elif K[last] >= 80:
        kd_txt = "KD 進入超買區"
    elif K[last] <= 20:
        kd_txt = "KD 進入超賣區"
    else:
        kd_txt = "KD 未達超買 / 超賣"

    # ---- 顯示視窗內的漲跌日統計 ----
    ups = sum(1 for i in range(w0 + 1, N) if cl[i] > cl[i - 1])
    downs = sum(1 for i in range(w0 + 1, N) if cl[i] < cl[i - 1])
    flats = (W - 1) - ups - downs

    # ---- 顯示視窗內的價量分布 ----
    dhi, dlo, dcl, dvo = cut(hi), cut(lo), cut(cl), cut(vo)
    ddate = cut(date)
    nb_price = 18 if W >= 24 else max(6, W // 2)
    nb_time = min(14, W)
    p_lo, p_hi = min(dlo), max(dhi)
    step = (p_hi - p_lo) / nb_price if p_hi > p_lo else 1.0
    tstep = max(1, math.ceil(W / nb_time))
    heat, tlabels = [], []
    for ti in range(0, W, tstep):
        chunk = list(range(ti, min(ti + tstep, W)))
        tlabels.append(ddate[chunk[-1]][5:])
        col = [0.0] * nb_price
        for i in chunk:
            bi = min(nb_price - 1, int((dcl[i] - p_lo) / step)) if step else 0
            col[bi] += dvo[i]
        for bi, v in enumerate(col):
            heat.append([len(tlabels) - 1, bi, round(v, 1)])
    plabels = ["%.0f" % (p_lo + (i + 0.5) * step) for i in range(nb_price)]

    vol_by_price = [0.0] * nb_price
    for i in range(W):
        bi = min(nb_price - 1, int((dcl[i] - p_lo) / step)) if step else 0
        vol_by_price[bi] += dvo[i]

    kline, patterns = extended_kline(raw, allb, W)

    return {
        "code": code,
        "name": raw.get("name") or code,
        "source": raw.get("source", ""),
        "generated": _dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "last_date": date[last],
        "bars_count": W,
        "history_count": N,
        "range": [ddate[0], date[last]],

        "dmi": {"period": 14, **{k: r2(v[last], 6) for k,v in directional.items()}},
        "volume_analysis": volume_assessment(c, prev_c, vo[last], vma20[last]),
        "score_model": "0922b-directional-volume",
        "series": {
            **{"bb_" + k: [r2(v, 6) for v in cut(bb[k])] for k in ("mid", "upper", "lower", "percent_b", "width", "width_rank")},
            **{k: [r2(v, 6) for v in cut(values)] for k,values in directional.items()},
            "date": ddate, "open": cut(op), "high": dhi, "low": dlo, "close": dcl, "vol": dvo,
            "ma5": [r2(v) for v in cut(ma5)], "ma10": [r2(v) for v in cut(ma10)],
            "ma20": [r2(v) for v in cut(ma20)], "ma60": [r2(v) for v in cut(ma60)],
            "vma20": [r2(v) for v in cut(vma20)],
            "k": [r2(v) for v in cut(K)], "d": [r2(v) for v in cut(D)],
            "dif": [r2(v) for v in cut(dif)], "sig": [r2(v) for v in cut(sig)],
            "osc": [r2(v) for v in cut(osc)],
            "rsi": [r2(v) for v in cut(rsi14)],
            "chip_foreign": [r["foreign"] for r in chip_rows],
            "chip_trust": [r["trust"] for r in chip_rows],
            "chip_dealer": [r["dealer"] for r in chip_rows],
            "chip_total": [r["total"] for r in chip_rows],
        },

        "quote": {
            "close": r2(c), "chg": r2(chg), "chg_pct": r2(chg_pct),
            "open": r2(op[last]), "high": r2(hi[last]), "low": r2(lo[last]),
            "vol": r2(vo[last], 3), "trades": allb[last]["trades"],
            "vma20": r2(vma20[last], 1), "vratio": r2(vratio),
        },

        "tech": {
            "ma5": r2(ma5[last]), "ma10": r2(ma10[last]),
            "ma20": r2(ma20[last]), "ma60": r2(ma60[last]),
            "k": r2(K[last]), "d": r2(D[last]),
            "dif": r2(dif[last]), "sig": r2(sig[last]), "osc": r2(osc[last]),
            "rsi": r2(rsi14[last]), "atr": r2(a), "atr_pct": r2(atr_pct),
            "bias20": r2(bias20), "vwap20": r2(vw20[last]),
            "support": r2(support), "resistance": r2(resistance),
            "pos20": r2(pos20, 1), "pos60": r2(pos60, 1),
            "trend_txt": trend_txt, "kd_txt": kd_txt,
            "ups": ups, "downs": downs, "flats": flats,
            "up_ratio": r2(ups / (W - 1) * 100, 1),
            "down_ratio": r2(downs / (W - 1) * 100, 1),
        },

        "scores": {
            "trend": r2(s_trend, 1), "momentum": r2(s_mom, 1),
            "chip": r2(s_chip, 1), "volume": r2(s_vol, 1),
            "tech": r2(tech_score, 1), "overall": r2(overall, 1),
        },

        "chip": {
            "has_data": bool(full_chip),
            "days": len(full_chip),
            "net5": r2(net5, 2), "net20": r2(net20, 2),
            "last": last_chip,
            "recent": list(reversed(all_chip_rows[-5:])),
            "coverage5": coverage5, "coverage20": coverage20,
            "latest_date": last_chip["date"] if last_chip else None,
            "stale": bool(last_chip and last_chip["date"] != date[last]),
        },

        "margin": mg_last,
        "backtest": bt,
        "fibonacci": fibonacci(date, hi, lo, cl, w0),
        "strategy_input": {
            "bars": [{"date": date[i], "open": op[i], "close": cl[i], "vol": vo[i],
                      "score": scores_at(i)[5], "chip_complete": scores_at(i)[2] is not None,
                      "bb_break_up": bb["break_up"][i]} for i in range(60, N)],
            "events": [x["date"] for x in (raw.get("dividends") or [])],
            "events_confirmed": raw.get("dividends") is not None and raw.get("dividend_status", "confirmed") == "confirmed",
        },
        "bollinger": {"period": 20, "multiplier": 2, "rank_window": 120,
                      **{k: (bb[k][last] if k in ("squeeze", "break_up", "break_down") else r2(bb[k][last], 6)) for k in bb}},
        "bench": bench_info,
        "dividends": {"available": raw.get("dividends") is not None and raw.get("dividend_status", "confirmed") == "confirmed",
                      "status": raw.get("dividend_status", "confirmed" if raw.get("dividends") is not None else "unavailable"), "recent": events},
        "market": raw.get("market"),
        "app": {"title": APP_TITLE, "credit": APP_CREDIT, "version": APP_VERSION},

        "plan": {
            "entry_lo": r2(entry_lo), "entry_hi": r2(entry_hi),
            "stop": r2(stop), "target": r2(target), "rr": r2(rr),
            "verdict": verdict, "vclass": vclass,
        },

        "kline": kline,
        "patterns": patterns,
        "heat": {"data": heat, "x": tlabels, "y": plabels,
                 "max": max((h[2] for h in heat), default=0)},
        "volprice": {"y": plabels, "v": [r2(v, 1) for v in vol_by_price]},

        "avail": {
            "price_days": W, "history_days": N,
            "chip_days": shown_chip_days, "chip_total_days": len(full_chip),
            "margin": bool(mg_last), "need_days": days,
            "price_latest": date[last],
            "chip_latest": last_chip["date"] if last_chip else None,
            "margin_latest": mg_last["date"] if mg_last else None,
            "margin_current": bool(mg_last and mg_last["date"] == date[last]
                                   and all(mg_last[k] is not None for k in
                                           ("margin_bal", "margin_prev", "short_bal", "short_prev"))),
            "indicators_ready": all(v is not None for v in
                                    (ma60[last], K[last], D[last], dif[last], sig[last],
                                     osc[last], rsi14[last], atr14[last], vw20[last])),
        },
    }


# --------------------------------------------------------------------------
# 產生 HTML
# --------------------------------------------------------------------------

def load_echarts(mode):
    """mode: 'inline' | 'cdn'"""
    if mode == "cdn":
        return ('<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/'
                'dist/echarts.min.js"></script>')
    for p in (os.path.join(HERE, "echarts.min.js"),
              os.path.join(HERE, "node_modules", "echarts", "dist", "echarts.min.js")):
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                return "<script>%s</script>" % f.read()
    log("  ! 找不到 echarts.min.js，改用 CDN (需連網才能看圖)")
    return ('<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/'
            'dist/echarts.min.js"></script>')


# --------------------------------------------------------------------------
# 自選群組（互動版與批次程式共用同一份 watchlists.json，可以直接用記事本改）
# --------------------------------------------------------------------------

MAX_GROUPS = 5          # 自選群組上限
MAX_PER_GROUP = 8       # 每組股票上限


def watchlist_path():
    return os.environ.get("TWBOARD_WATCHLIST_FILE") or os.path.join(HERE, "watchlists.json")


def load_watchlists():
    """回傳 {群組名稱: [代號, ...]}；檔案不存在或壞掉時回空字典，不讓程式因此起不來。"""
    try:
        with open(watchlist_path(), "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    if isinstance(data, dict):
        for name, codes in data.items():
            if isinstance(name, str) and isinstance(codes, list):
                clean = [str(c).strip().upper() for c in codes
                         if re.fullmatch(r"[0-9A-Za-z]{2,10}", str(c).strip())]
                if clean:
                    # 檔案裡若有舊版存的超額群組，讀取時照樣保留，只在儲存時檢查上限；
                    # 不在這裡靜默截掉使用者的資料。
                    out[name] = clean
    return out


def save_watchlists(groups):
    path = watchlist_path()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(groups, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _part(name):
    p = os.path.join(HERE, name)
    if not os.path.exists(p):
        raise SystemExit("找不到 %s（請確認所有檔案放在同一個資料夾）" % name)
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def legal_text():
    """命令列用的授權聲明（GPLv3 第 5(d) 條：互動式程式須顯示適當的法律聲明）。"""
    lines = ["%s  —  %s" % (APP_TITLE, APP_COPYRIGHT),
             "本程式是自由軟體，依 GNU 通用公共授權第 3 版（GPL-3.0-only）釋出，不附任何擔保；",
             "歡迎依授權條款再散布。授權全文見 LICENSE，匯出報告的額外許可見 LICENSE-EXCEPTION.md。"]
    if APP_SOURCE_URL:
        lines.append("原始碼：%s" % APP_SOURCE_URL)
    return "\n".join(lines)


def legal_html(exported=False):
    """頁面用的授權聲明。互動版可連到本機伺服器提供的授權全文；匯出檔是單一檔案，只放文字與原始碼網址。"""
    src = (' 原始碼：<a href="%s" rel="noopener">%s</a>。' % (_html.escape(APP_SOURCE_URL, True), _html.escape(APP_SOURCE_URL))
           if APP_SOURCE_URL else "")
    if exported:
        body = ("本報告由 %s 產生。%s。該程式是自由軟體，依 GNU GPL 第 3 版（GPL-3.0-only）釋出，<b>不附任何擔保</b>。"
                "依該專案的額外許可（GPLv3 第 7 條），這份匯出的報告可以自由轉寄、張貼，不必另附授權全文。"
                "內嵌的 Apache ECharts 依 Apache-2.0 授權。%s行情資料的權利屬於各資料來源。"
                % (_html.escape(APP_TITLE), _html.escape(APP_COPYRIGHT), src))
    else:
        body = ('%s。本程式是自由軟體，依 <a href="/LICENSE" target="_blank" rel="noopener">GNU GPL 第 3 版（GPL-3.0-only）</a>釋出，'
                '<b>不附任何擔保</b>；歡迎依授權條款再散布。'
                '<a href="/LICENSE-EXCEPTION" target="_blank" rel="noopener">匯出報告的額外許可</a>｜'
                '<a href="/THIRD-PARTY-NOTICES" target="_blank" rel="noopener">第三方元件聲明</a>。%s'
                '行情資料的權利屬於各資料來源，請遵守其使用條款。' % (_html.escape(APP_COPYRIGHT), src))
    return '<footer class="legal" id="legal">%s</footer>' % body


def assemble(shell, echarts_tag, payload=None, extra=None):
    """把 CSS / 18格 markup / 繪圖 JS / ECharts / payload 組裝成一份 HTML。"""
    html = shell.replace("__APP_TITLE__", APP_TITLE).replace("__APP_CREDIT__", APP_CREDIT)
    html = html.replace("<!--__LEGAL__-->", legal_html(exported=payload is not None))
    html = html.replace("/*__CSS__*/", _part("board.css"))
    html = html.replace("<!--__BODY__-->", _part("board_body.html"))
    html = html.replace("/*__BOARDJS__*/", _part("strategy_engine.js") + "\n" + _part("board.js") + "\n" + _part("glossary.js"))
    html = html.replace("<!--__ECHARTS__-->", echarts_tag)
    if "/*__MARKETJS__*/" in html:                      # 市場掃描只在互動版；匯出報告不需要
        html = html.replace("/*__MARKETJS__*/", _part("market.js"))
    if payload is not None:
        html = html.replace("/*__PAYLOAD__*/null",
                            json.dumps(payload, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c"))
    for k, v in (extra or {}).items():
        html = html.replace(k, v)
    return html


def render(payload, echarts_tag, template_path=None):
    shell = _part(os.path.basename(template_path)) if template_path else _part("board_template.html")
    return assemble(shell, echarts_tag, payload,
                    {"__TITLE__": _html.escape("%s %s · %s" % (payload["code"], payload["name"], APP_TITLE))})


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def fetch_raw(code, display_days, source="auto", token="", ep=None, throttle=0.35, verbose=True):
    """依來源取得原始資料。回傳 raw dict 或 None。伺服器與 CLI 共用。"""
    ep = ep or DEFAULT_ENDPOINTS
    end = TC.today()
    start = end - _dt.timedelta(days=history_calendar_days(display_days))
    s_, e_ = start.isoformat(), end.isoformat()

    if source == "demo":
        TC.report("示範資料", "產生離線合成資料")
        return fetch_demo(code, days=max(160, int(display_days) + 120), history_days=DEMO_HISTORY)

    raw = None
    if source in ("auto", "finmind"):
        raw = fetch_finmind(code, s_, e_, token, ep)
        if raw and verbose:
            log("    · FinMind 取得 %d 筆日K、%d 天法人" % (len(raw["bars"]), len(raw["chips"])))
    if not raw and source in ("auto", "twse"):
        if verbose:
            log("    · 改用證交所官方 API…")
        TC.report("切換來源", "FinMind 未提供股價，改查證交所")
        raw = fetch_twse(code, s_, e_, throttle=throttle, chip_days=display_days, ep=ep)
        if raw and verbose:
            log("    · 證交所取得 %d 筆日K、%d 天法人" % (len(raw["bars"]), len(raw["chips"])))
    return raw


def run_one(code, args, token):
    log("\n[%s] 取得資料…" % code)
    ep = endpoints({"finmind": args.finmind_api, "twse_day": args.twse_day_api,
                    "twse_t86": args.twse_t86_api, "twse_margin": args.twse_margin_api})
    src = "demo" if args.demo else args.source
    with TC.operation():
        raw = fetch_raw(code, args.days, src, token, ep)
        fetch_info = TC.public_info()
    if not raw:
        log("    x %s 取不到資料，略過" % code)
        return None

    data = analyse(code, raw, args.days)
    data["fetch_info"] = dict(fetch_info, mode="demo" if src=="demo" else "incremental" if fetch_info["network_requests"] else "local")
    html = render(data, load_echarts("cdn" if args.cdn else "inline"), args.template)

    os.makedirs(args.out, exist_ok=True)
    fn = os.path.join(args.out, "%s_%s_戰略圖.html" % (code, data["name"]))
    with open(fn, "w", encoding="utf-8") as f:
        f.write(html)
    log("    ✓ %s  (%s 收盤 %s，%s)" % (fn, data["last_date"],
                                       data["quote"]["close"], data["plan"]["verdict"]))
    if args.json:
        jf = os.path.splitext(fn)[0] + ".json"
        with open(jf, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        log("    ✓ %s" % jf)
    return fn


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=APP_TITLE+" — 輸入代號，產生 18 格單檔互動 HTML",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="範例：\n  python twboard.py 2330\n"
               "  python twboard.py 2330 3374 3443 --days 120 --out ./out\n"
               "  python twboard.py 2330 --source twse\n"
               "  python twboard.py DEMO --demo\n")
    ap.add_argument("codes", nargs="+", help="股票代號，可多個 (上市或上櫃)")
    ap.add_argument("--days", type=int, default=30, help="顯示交易日數 (預設 30；指標另外用約 100 日暖身)")
    ap.add_argument("--out", default="./out", help="輸出資料夾 (預設 ./out)")
    ap.add_argument("--source", choices=["auto", "finmind", "twse", "demo"],
                    default="auto", help="資料來源 (預設 auto)")
    ap.add_argument("--token", default=None, help="FinMind API token（也可用環境變數 FINMIND_TOKEN）")
    ap.add_argument("--cdn", action="store_true", help="用 CDN 載 ECharts，檔案變小但需連網")
    ap.add_argument("--json", action="store_true", help="同時輸出原始計算結果 JSON")
    ap.add_argument("--demo", action="store_true", help="用合成資料（離線測試版型）")
    ap.add_argument("--template", default=None, help="自訂版型檔路徑")
    ap.add_argument("--finmind-api", default=None, help="自訂 FinMind API 網址")
    ap.add_argument("--twse-day-api", default=None, help="自訂 證交所日K API 網址")
    ap.add_argument("--twse-t86-api", default=None, help="自訂 證交所三大法人 API 網址")
    ap.add_argument("--twse-margin-api", default=None, help="自訂 證交所融資券 API 網址")
    args = ap.parse_args(argv)
    log(legal_text())

    token = args.token or os.environ.get("FINMIND_TOKEN") or ""
    made = []
    for code in args.codes:
        code = code.strip().upper()
        try:
            f = run_one(code, args, token)
            if f:
                made.append(f)
        except Exception as ex:                       # noqa: BLE001
            log("    x %s 失敗：%s" % (code, ex))

    log("\n完成 %d / %d 檔。" % (len(made), len(args.codes)))
    if made:
        log("輸出：%s" % os.path.abspath(args.out))
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
