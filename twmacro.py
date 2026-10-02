# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""
總體市場面板：美元兌台幣匯率，以及台股、美股、日股大盤走勢。

資料來源
--------
* 美元兌台幣：FinMind TaiwanExchangeRate（data_id=USD，台灣銀行牌告；用即期買入／賣出的中價）
* 台股加權指數：FinMind TaiwanStockPrice（data_id=TAIEX，價格指數，與主畫面相對強弱同口徑）
* 美股、日股指數：FinMind USStockPrice（^GSPC、^IXIC、^N225）；取不到時改用 Stooq 的每日 CSV
  （^spx、^ndq、^nkx）。可用範圍與配額依來源而定；Stooq 只當備援，取不到就顯示無資料。
* 選用的第三備援：Yahoo 財經的非官方 chart 端點（預設關閉，在進階設定勾選才使用）。
  Yahoo 沒有官方 API，網址可能改版或限流，資料僅供個人使用；還在交易中的當天 K 棒不採用。

每一條序列各自有自己的交易日（台、美、日假日不同），前端用時間軸各畫各的，不對齊、不補值。
"""
import math
import csv
import datetime as _dt
import io
import random
import time
import urllib.parse
import zlib

import twboard as T
import twcache as TC

SERIES = [
    {"id": "USDTWD", "name": "美元兌台幣", "kind": "fx", "unit": "元", "digits": 3,
     "note": "台灣銀行牌告即期中價；假日與未報價日不列入"},
    {"id": "TAIEX", "name": "台股加權指數", "kind": "index", "region": "台股", "digits": 0},
    {"id": "^GSPC", "name": "S&P 500", "kind": "index", "region": "美股", "digits": 0, "stooq": "^spx", "yahoo": "^GSPC"},
    {"id": "^IXIC", "name": "那斯達克", "kind": "index", "region": "美股", "digits": 0, "stooq": "^ndq", "yahoo": "^IXIC"},
    {"id": "^N225", "name": "日經 225", "kind": "index", "region": "日股", "digits": 0, "stooq": "^nkx", "yahoo": "^N225"},
]


def valid_day(value, start, end):
    try:
        return isinstance(value,str) and len(value)==10 and _dt.date.fromisoformat(value).isoformat()==value and start <= value <= end
    except ValueError:
        return False


def _fm_rows(dataset, data_id, start, end, token, ep, value_of):
    """透過 FinMind 逐日快取取得 [{"date","value"}]；value_of 從原始列取數值，None 代表該日無值。"""
    headers = {"Authorization": "Bearer " + token} if token else {}
    key = TC.key_for("macro-v2-spot-only", ep["finmind"], dataset, data_id)

    def fetch(first, last):
        j = T.http_get_json(ep["finmind"], {"dataset": dataset, "data_id": data_id,
                                            "start_date": first, "end_date": last}, headers=headers)
        if not j or j.get("status") not in (200, "200") or not isinstance(j.get("data"), list):
            return None
        out = []
        for r in j["data"]:
            if isinstance(r, dict) and valid_day(r.get("date"), first, last):
                v = value_of(r)
                if v is not None and math.isfinite(v) and v > 0:
                    out.append({"date": r["date"], "value": v})
        return out
    return TC.range_data(key, start, end, fetch, refresh_recent=ep.get("_force_recent", False))


def _stooq_rows(symbol, start, end, ep):
    """Stooq 每日 CSV：Date,Open,High,Low,Close,Volume。回 [{"date","value"}] 或 None。"""
    key = TC.key_for("macro-stooq-v2", ep["stooq"], symbol)

    def fetch(first, last):
        text = T.http_get_json(ep["stooq"], {"s": symbol, "i": "d", "d1": first.replace("-", ""),
                                             "d2": last.replace("-", "")}, raw_text=True)
        if not text or "Date" not in text[:200]:
            return None
        out = []
        for r in csv.DictReader(io.StringIO(text)):
            v = T.to_float(r.get("Close"))
            d = (r.get("Date") or "").strip()
            if v and math.isfinite(v) and v > 0 and valid_day(d, first, last):
                out.append({"date": d, "value": v})
        return out
    return TC.range_data(key, start, end, fetch, refresh_recent=ep.get("_force_recent", False))


YAHOO_LABEL = "Yahoo 財經（非官方）"


def parse_yahoo_chart(j, first, last, now=None):
    """Yahoo v8 chart → [{"date","value"}]（收盤）。

    * 時間戳記是 UTC 秒數，加上 meta.gmtoffset 換成交易所當地日期（日經看東京時間）。
    * 還在交易中的那一根（目前交易時段、收盤後 30 分鐘內）不採用，避免把盤中價當成收盤存進快取。
    """
    now = time.time() if now is None else now
    res = ((j or {}).get("chart") or {}).get("result") if isinstance(j, dict) else None
    if not isinstance(res, list) or not res or not isinstance(res[0], dict):
        return None
    r = res[0]
    meta = r.get("meta") or {}
    ts = r.get("timestamp") or []
    quote = ((r.get("indicators") or {}).get("quote") or [{}])[0] or {}
    closes = quote.get("close") or []
    if not isinstance(ts, list) or not isinstance(closes, list):
        return None
    try:
        offset = int(meta.get("gmtoffset") or 0)
    except (TypeError, ValueError):
        offset = 0
    reg = ((meta.get("currentTradingPeriod") or {}).get("regular") or {})
    live_start, live_end = reg.get("start"), reg.get("end")
    local = lambda sec: _dt.datetime.fromtimestamp(sec + offset, _dt.timezone.utc).date().isoformat()
    today_local = local(now)
    out = []
    for t, c in zip(ts, closes):
        if not isinstance(t, (int, float)) or c is None:
            continue
        v = T.to_float(c)
        if not v or not math.isfinite(v) or v <= 0:
            continue
        day = local(t)
        if isinstance(live_start, (int, float)) and isinstance(live_end, (int, float)):
            if live_start <= t <= live_end and now < live_end + 1800:
                continue                                  # 這一根還在交易中
        elif day >= today_local:
            continue                                      # 沒有交易時段資訊時，保守地不收今天
        if valid_day(day, first, last):
            out.append({"date": day, "value": round(v, 4)})
    return out


def _yahoo_rows(symbol, start, end, ep):
    key = TC.key_for("macro-yahoo-v1", ep["yahoo"], symbol)

    def fetch(first, last):
        p1 = int(_dt.datetime.fromisoformat(first).replace(tzinfo=_dt.timezone.utc).timestamp()) - 86400
        p2 = int(_dt.datetime.fromisoformat(last).replace(tzinfo=_dt.timezone.utc).timestamp()) + 2 * 86400
        j = T.http_get_json(ep["yahoo"].rstrip("/") + "/" + urllib.parse.quote(symbol),
                            {"period1": p1, "period2": p2, "interval": "1d", "includePrePost": "false"})
        return parse_yahoo_chart(j, first, last)
    return TC.range_data(key, start, end, fetch, refresh_recent=ep.get("_force_recent", False))


def _fx_mid(r):
    buy, sell = T.to_float(r.get("spot_buy")), T.to_float(r.get("spot_sell"))
    if buy and sell and math.isfinite(buy) and math.isfinite(sell) and 0 < buy <= sell:
        return round((buy + sell) / 2.0, 4)
    return None


def _warnings():
    return list((TC.state() or {}).get("warnings", []))


def _forget_warnings(prefix, since, until):
    """備援來源取得了新資料時，拿掉前面失敗來源留下的同一序列警示（它們已經不影響畫面上的數字）。"""
    st = TC.state()
    if not st:
        return
    drop = {w for w in until if w not in since and w.startswith(prefix)}
    with TC._state_lock:
        st["warnings"] = [w for w in st["warnings"] if w not in drop]


def fetch_series(spec, start, end, token, ep):
    """回傳 (rows, source_label)。rows 依日期排序、去重；取不到回 ([], None)。"""
    rows, label = None, None
    if spec["id"] == "USDTWD":
        rows = _fm_rows("TaiwanExchangeRate", "USD", start, end, token, ep, lambda r: _fx_mid(r) if r.get("currency") in (None,"USD") else None); label = "FinMind（台銀牌告）"
    elif spec["id"] == "TAIEX":
        rows = _fm_rows("TaiwanStockPrice", "TAIEX", start, end, token, ep,
                        lambda r: T.to_float(r.get("close")) if r.get("stock_id") == "TAIEX" else None); label = "FinMind"
    else:
        initial = _warnings()
        rows = _fm_rows("USStockPrice", spec["id"], start, end, token, ep,
                        lambda r: T.to_float(r.get("Close")) if r.get("stock_id") in (spec["id"], None) else None)
        label = "FinMind"
        if spec.get("stooq") and (not rows or (_dt.date.fromisoformat(end)-_dt.date.fromisoformat(max(r["date"] for r in rows))).days > 7):
            TC.report(spec["name"], "FinMind 無資料或日期較舊，檢查 Stooq")
            before = _warnings()
            fallback = _stooq_rows(spec["stooq"], start, end, ep)
            if fallback and (not rows or max(r["date"] for r in fallback) > max(r["date"] for r in rows)):
                rows, label = fallback, "Stooq"
                _forget_warnings(spec["name"] + "：", initial, before)
        if spec.get("yahoo") and ep.get("_yahoo") and (
                not rows or (_dt.date.fromisoformat(end)-_dt.date.fromisoformat(max(r["date"] for r in rows))).days > 7):
            TC.report(spec["name"], "FinMind／Stooq 無資料或日期較舊，檢查 Yahoo 財經")
            before = _warnings()
            fallback = _yahoo_rows(spec["yahoo"], start, end, ep)
            if fallback and (not rows or max(r["date"] for r in fallback) > max(r["date"] for r in rows)):
                rows, label = fallback, YAHOO_LABEL
                _forget_warnings(spec["name"] + "：", initial, before)
    if not rows:
        return [], None
    by_date = {}
    for r in rows:
        by_date[r["date"]] = r["value"]
    return [{"date": d, "value": by_date[d]} for d in sorted(by_date)], label


def _demo_series(spec, start, end):
    rnd = random.Random(zlib.crc32(spec["id"].encode("utf-8")))   # 字元碼加總會讓 ^GSPC 與 ^IXIC 撞種子
    level = {"USDTWD": 32.0, "TAIEX": 24000.0, "^GSPC": 5800.0, "^IXIC": 19000.0, "^N225": 39000.0}[spec["id"]]
    sigma = 0.003 if spec["kind"] == "fx" else 0.011
    out, d = [], _dt.date.fromisoformat(start)
    stop = _dt.date.fromisoformat(end)
    while d <= stop:
        if d.weekday() < 5:
            level *= 1 + rnd.gauss(0.0002, sigma)
            out.append({"date": d.isoformat(), "value": round(level, 3)})
        d += _dt.timedelta(days=1)
    return out


def _change(rows, back):
    if len(rows) <= back or not rows[-1 - back]["value"]:
        return None
    a, b = rows[-1 - back]["value"], rows[-1]["value"]
    return {"abs": T.r2(b - a, 3), "pct": T.r2((b / a - 1) * 100.0)}


def build(days=60, token="", ep=None, source="auto"):
    """組出面板資料。days＝畫面上要顯示的交易日數（各序列各取自己最後 days 個交易日）。"""
    ep = ep or T.DEFAULT_ENDPOINTS
    days = max(10, min(500, int(days)))
    end = T.TC.today()
    start = end - _dt.timedelta(days=T.history_calendar_days(days))
    s, e = start.isoformat(), end.isoformat()
    def load(spec):
        TC.report(detail="檢查歷史資料與缺少日期")
        if source == "demo":
            return _demo_series(spec, s, e), "合成資料（非真實行情）"
        return fetch_series(spec, s, e, token, ep)

    # 五個序列互不相依，一起抓：等待時間由「相加」變成「最慢的一個」。
    TC.report("總經面板", "同時讀取匯率與各國大盤")
    fetched = TC.parallel([(spec["name"], (lambda sp=spec: load(sp))) for spec in SERIES])
    out = []
    for spec, (rows, label) in zip(SERIES, fetched):
        history = rows
        rows = rows[-days:]
        item = {k: spec[k] for k in ("id", "name", "kind", "digits") if k in spec}
        item["region"] = spec.get("region"); item["unit"] = spec.get("unit"); item["note"] = spec.get("note")
        if rows:
            base = rows[0]["value"]
            item.update({
                "available": True, "source": label, "count": len(rows),
                "age_days": (end-_dt.date.fromisoformat(rows[-1]["date"])).days,
                "stale": (end-_dt.date.fromisoformat(rows[-1]["date"])).days > 7,
                "basis": "spot_mid" if spec["kind"] == "fx" else "price",
                "from": rows[0]["date"], "to": rows[-1]["date"],
                "latest": T.r2(rows[-1]["value"], 3), "d1": _change(history, 1), "d5": _change(history, 5), "d20": _change(history, 20),
                "window_pct": T.r2((rows[-1]["value"] / base - 1) * 100.0) if base else None,
                "high": T.r2(max(r["value"] for r in rows), 3), "low": T.r2(min(r["value"] for r in rows), 3),
                "series": [[r["date"], T.r2(r["value"], 3)] for r in rows],
            })
        else:
            item.update({"available": False, "source": None, "count": 0, "series": []})
        out.append(item)
    latest_dates = [x["to"] for x in out if x.get("available")]
    return {"days": days, "generated": _dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "series": out, "latest_date": max(latest_dates) if latest_dates else None,
            "missing": [x["name"] for x in out if not x["available"]]}
