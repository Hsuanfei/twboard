#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""
台股戰略圖產生器 — 本機互動版伺服器
====================================
在你自己的電腦上開一個小網站，頁面上就能輸入股票代號、選資料來源、改分析天數。

    python twserve.py

然後瀏覽器會自動開啟 http://127.0.0.1:8899

為什麼要有這支程式
------------------
瀏覽器直接呼叫證交所的 API 會被跨網域限制（CORS）擋掉。
這支伺服器跑在你本機，由它去抓資料再交給頁面，就沒有這個問題。
它只綁定 127.0.0.1，外面的電腦連不進來；資料也不經過任何第三方。

參數
----
    python twserve.py --port 8899      # 換埠號
    python twserve.py --no-browser     # 不要自動開瀏覽器
    python twserve.py --token <token>  # 預先填入 FinMind token
"""

import argparse
import csv
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import secrets
from collections import OrderedDict
import io
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import twboard as T
import twmacro as M
import twcompare as C
import twmarket as MK
import twpower as P
import twusage as U
import twxlsx

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_TTL = 600           # 原始資料快取秒數
WARN_TTL = 120            # 有警示（部分資料缺漏）時只短暫快取，很快就重試缺漏區間，但不會每次都整份重抓
_cache = {}
_lock = threading.Lock()
DEFAULT_TOKEN = ""
DEMO_MODE = False
SESSION_TOKEN = None
_snapshots = OrderedDict()
MAX_SNAPSHOTS = 128
_jobs = OrderedDict()
_job_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="twboard-fetch")   # 多檔同時分析
MAX_PENDING_JOBS = 32     # 排隊上限；群組一次載入 8 檔也不會被拒絕
MAX_JOBS = 64
JOB_TTL = 3600



# --------------------------------------------------------------------------

def _clean_code(s):
    s = (s or "").strip().upper()
    if not re.fullmatch(r"[0-9A-Z]{2,10}", s):
        raise ValueError("股票代號格式不正確")
    return s


def _ep_from(q):
    return T.endpoints({
        "finmind": q.get("finmind", [""])[0],
        "twse_day": q.get("twse_day", [""])[0],
        "twse_t86": q.get("twse_t86", [""])[0],
        "twse_margin": q.get("twse_margin", [""])[0],
        "stooq": q.get("stooq", [""])[0],
    })


def get_payload(q, progress=None, token_override=None):
    """依查詢參數取得（必要時抓取）並分析，回傳 payload dict。"""
    code = _clean_code(q.get("code", [""])[0])
    days = int(q.get("days", ["30"])[0] or 30)
    days = max(10, min(500, days))
    source = q.get("source", ["auto"])[0]
    if source not in ("auto", "finmind", "twse", "demo"):
        source = "auto"
    if DEMO_MODE:
        source = "demo"
    with _lock:
        token = token_override if token_override is not None else (DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN)
    ep = _ep_from(q)

    key = (code, source, ep["finmind"], ep["twse_day"], ep["twse_t86"],
           ep["twse_margin"], hashlib.sha256(token.encode()).hexdigest())
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    with T.TC.operation(progress):
        T.TC.report("本機快取", "檢查已取得的資料")
        if hit and hit["days"] >= days and now-hit["ts"] < hit.get("ttl", CACHE_TTL):
            raw = hit["raw"]
            T.TC.count("cache_hits")
            T.TC._note_activity("cache")
            for warning in hit.get("warnings",[]):
                T.TC.warn(warning)
            mode = "memory"
            T.TC.report("本機快取", "沿用最近分析資料，無需重新下載")
        else:
            fetch_days = max(days, hit["days"] if hit else 0, 120)
            raw = T.fetch_raw(code, fetch_days, source, token, ep, throttle=0.3, verbose=True)
            if not raw:
                raise ValueError("取不到資料。請確認代號、網路或資料來源。")
            mode = "local" if T.TC.public_info()["network_requests"] == 0 else "incremental"
            # 有失敗時不延長整份資料的快取期限；下次會重試缺漏區間。
            info = T.TC.public_info()
            with _lock:
                _cache[key] = {"raw":raw, "days":fetch_days, "ts":time.time(),
                               "ttl":WARN_TTL if info["warnings"] else CACHE_TTL, "warnings":info["warnings"][:]}
                if len(_cache)>128:
                    _cache.pop(next(iter(_cache)))
        T.TC.report("指標計算", "計算指標與資料完整度")
        payload = T.analyse(code, raw, days)
        payload["fetch_info"] = dict(T.TC.public_info(), mode="demo" if source=="demo" else mode)
        payload["comparison_notes"] = C.notes(payload)
        T.TC.report("完成", "分析完成")
        return payload


def start_job(q):
    code = _clean_code(q.get("code",[""])[0])
    with _lock:
        now = time.time()
        for key,job in list(_jobs.items()):
            if job["status"] in ("done","error") and now-job["updated"]>JOB_TTL:
                del _jobs[key]
        if sum(j["status"] in ("queued","running") for j in _jobs.values()) >= MAX_PENDING_JOBS:
            raise ValueError("目前載入工作較多，請稍後重試。")
        while len(_jobs)>=MAX_JOBS:
            finished = next((key for key,j in _jobs.items() if j["status"] in ("done","error")),None)
            if finished is None:
                raise ValueError("目前載入工作較多，請稍後重試。")
            del _jobs[finished]
        job_id = secrets.token_urlsafe(24)
        token = DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN
        _jobs[job_id] = {"job_id":job_id,"code":code,"status":"queued","stage":"等待處理",
                         "detail":"已加入載入佇列","cache_hits":0,"network_requests":0,
                         "reused_days":0,"downloaded_days":0,"warnings":[],"updated":now}
    def update(values):
        with _lock:
            _jobs[job_id].update(values)
            _jobs[job_id]["updated"] = time.time()
    def worker():
        update({"status":"running"})
        try:
            data = save_snapshot(get_payload(q, progress=update, token_override=token))
            update({"status":"done","stage":"完成","detail":"分析完成","data":data})
        except Exception:
            update({"status":"error","stage":"失敗","error":"無法完成分析，請確認股票代號、網路或資料來源後重試。"})
    _job_pool.submit(worker)
    return job_id


def job_status(job_id):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise ValueError("載入工作已失效，請重新查詢。")
        return copy.deepcopy(job)



def load_groups():
    return T.load_watchlists()


_macro_snapshots = OrderedDict()
_macro_cache = {}          # days -> {"data", "ts"}
MACRO_TTL = 600


def get_macro(q):
    """總體面板資料；同一個天數 10 分鐘內共用，之後由快取層做增量更新。"""
    days = max(10, min(500, int(q.get("days", ["60"])[0] or 60)))
    source = "demo" if DEMO_MODE else "auto"
    ep = _ep_from(q)
    yahoo = q.get("yahoo", ["0"])[0] == "1"
    key = (days, source, ep["finmind"], ep["stooq"], yahoo)
    now = time.time()
    with _lock:
        token = DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN
        key = key + (hashlib.sha256(token.encode()).hexdigest(),)
        hit = _macro_cache.get(key)
    if hit and now - hit["ts"] < hit.get("ttl", MACRO_TTL) and q.get("refresh", ["0"])[0] != "1":
        T.TC._note_activity("cache")
        return hit["data"]
    ep = dict(ep, _force_recent=q.get("refresh", ["0"])[0] == "1", _yahoo=yahoo)
    with T.TC.operation():
        data = M.build(days, token, ep, source)
        data["warnings"] = T.TC.public_info()["warnings"]
    data["snapshot_id"] = secrets.token_urlsafe(24)
    with _lock:
        _macro_snapshots[data["snapshot_id"]] = copy.deepcopy(data)
        while len(_macro_snapshots) > MAX_SNAPSHOTS:
            _macro_snapshots.popitem(last=False)
        _macro_cache[key] = {"data": data, "ts": now, "ttl": WARN_TTL if data["warnings"] else MACRO_TTL}
        while len(_macro_cache) > 8:
            _macro_cache.pop(next(iter(_macro_cache)))
    return data


_power_cache = OrderedDict()   # (代號, 分頁, …) -> {"data", "ts", "ttl"}
POWER_TTL = 600


def get_power(q):
    """強力分析的一個分頁。十分鐘內重複開同一頁直接回記憶體；「重抓」會重新確認近 7 日資料。"""
    code = _clean_code(q.get("code", [""])[0])
    part = q.get("part", ["risk"])[0]
    if part not in P.PART_KEYS:
        raise ValueError("未知的分析項目")
    extra = P.clean_us(q.get("us", [""])[0]) if part == "us" else []
    refresh = q.get("refresh", ["0"])[0] == "1"
    yahoo = q.get("yahoo", ["0"])[0] == "1"
    ep = _ep_from(q)
    with _lock:
        token = DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN
    key = (code, part, tuple(extra), ep["finmind"], ep["stooq"], yahoo, DEMO_MODE,
           hashlib.sha256(token.encode()).hexdigest())
    now = time.time()
    with _lock:
        hit = _power_cache.get(key)
    if hit and not refresh and hit.get("day") == T.TC.today().isoformat() and 0 <= now - hit["ts"] < hit["ttl"]:
        # 前端只能沿用剩餘壽命，不能在每次讀取時把舊結果再延長十分鐘。
        T.TC._note_activity("cache")
        return dict(hit["data"], cache_ttl_seconds=max(1, int(hit["ttl"] - (now - hit["ts"]))))
    with T.TC.operation():
        data = P.build(code, part, token, dict(ep, _yahoo=yahoo), demo=DEMO_MODE, us_extra=extra, refresh=refresh)
        data["warnings"] = T.TC.public_info()["warnings"]
        data["network_requests"] = T.TC.public_info()["network_requests"]
        data["cache_ttl_seconds"] = WARN_TTL if data["warnings"] or not data.get("available", True) else POWER_TTL
    with _lock:
        _power_cache[key] = {"data": data, "ts": time.time(), "day": T.TC.today().isoformat(), "ttl": data["cache_ttl_seconds"]}
        while len(_power_cache) > 96:
            _power_cache.popitem(last=False)
    return data


def usage_view(q):
    """角落「資料來源」小視窗：FinMind 用量、各來源連線狀態、本機資料庫。只讀本機紀錄，不會花 FinMind 額度。"""
    with _lock:
        token = DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN
        running = sum(j["status"] in ("queued", "running") for j in _jobs.values())
    data = U.snapshot("" if DEMO_MODE else token, fetch_official=not DEMO_MODE)
    data.update(demo=DEMO_MODE, jobs=running)
    return data


def clear_cache():
    """「清除本機資料庫」：有分析或掃描正在進行時不清，避免寫到一半。"""
    with _lock:
        if any(j["status"] in ("queued", "running") for j in _jobs.values()):
            raise ValueError("還有分析或市場掃描正在進行，請等完成後再清除。")
    removed = T.TC.clear_all()
    with _lock:
        _cache.clear(); _power_cache.clear(); _macro_cache.clear()
    return {"removed": removed, "cache": T.TC.stats_detail(max_age=0)}


def latest_macro():
    """匯出報告用：拿目前記憶體裡最新的一份面板資料，沒有就不附。"""
    with _lock:
        items = sorted(_macro_cache.values(), key=lambda x: x["ts"])
    return items[-1]["data"] if items else None


# ==========================================================================
# 20260925a：全市場掃描、概念族群、到價警示、模擬持倉
# ==========================================================================
_market = {"raw": None, "days": 60, "results": {}, "job": None, "by": {}}
_market_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="twboard-market")
AMOUNT_CHOICES = (0, 1e7, 3e7, 1e8)


def _min_amount(q):
    try:
        v = float(q.get("min_amount", ["3e7"])[0] or 3e7)
    except ValueError:
        raise ValueError("最低成交值參數不正確") from None
    if v not in AMOUNT_CHOICES:
        raise ValueError("最低成交值參數不正確")
    return v


def _market_result(min_amount):
    """用記憶體裡的全市場原始資料算出結果（同一個門檻只算一次）。"""
    with _lock:
        raw = _market["raw"]
        hit = _market["results"].get(min_amount)
    if hit:
        return hit
    if raw is None:
        return None
    themes, _ = MK.load_themes()
    res = MK.analyse(raw, themes, min_amount)
    res["warnings"] = raw.get("_warnings", [])
    res["scan_days"] = raw.get("_days")
    with _lock:
        if _market["raw"] is raw:
            _market["results"][min_amount] = res
            _market["by"] = {s["code"]: s for s in res["stocks"]}
            _market["latest"] = res["latest_date"]
    return res


def theme_names(themes):
    """族群編輯器「只填代號也可以」：用最近一次掃描（或產業別清單）的股票名稱補上。"""
    by = _market.get("by") or {}
    info = (_market.get("raw") or {}).get("info") or {}
    out = {}
    for t in themes:
        for c in t["codes"]:
            name = (by.get(c) or {}).get("name") or (info.get(c) or {}).get("name")
            if name:
                out[c] = name
    return out


def get_market(q):
    """頁面載入時呼叫：只用本機快取，不連網；快取夠用就直接出結果。"""
    min_amount = _min_amount(q)
    with _lock:
        have = _market["raw"] is not None
    if not have:
        if DEMO_MODE:
            return None
        with T.TC.operation():
            raw = MK.collect(_market["days"] + 1, allow_network=False)
        if not raw or len(set(raw["twse"]) | set(raw["tpex"])) < 6:
            return None
        raw["_warnings"], raw["_days"] = [], _market["days"]
        raw["_cached_only"] = True
        with _lock:
            if _market["raw"] is None:
                _market["raw"], _market["results"] = raw, {}
    res = _market_result(min_amount)
    if res is not None:
        res = dict(res, cached_only=bool((_market["raw"] or {}).get("_cached_only")))
    return res


def start_market_scan(q):
    days = int(q.get("days", ["60"])[0] or 60)
    if days not in MK.SCAN_DAYS:
        raise ValueError("掃描期間只能選 20 或 60 個交易日")
    min_amount = _min_amount(q)
    with _lock:
        job = _market["job"]
        if job and _jobs.get(job, {}).get("status") in ("queued", "running"):
            return job
        job_id = secrets.token_urlsafe(24)
        token = DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN
        _jobs[job_id] = {"job_id": job_id, "code": "市場掃描", "status": "queued", "stage": "等待處理", "detail": "",
                         "cache_hits": 0, "network_requests": 0, "reused_days": 0, "downloaded_days": 0,
                         "warnings": [], "progress": [0, 1], "updated": time.time()}
        _market["job"] = job_id
        while len(_jobs) > MAX_JOBS:
            finished = next((k for k, j in _jobs.items() if j["status"] in ("done", "error")), None)
            if finished is None:
                break
            del _jobs[finished]

    def update(values):
        with _lock:
            _jobs[job_id].update(values)
            _jobs[job_id]["updated"] = time.time()

    def worker():
        update({"status": "running"})
        try:
            with T.TC.operation(update):
                if DEMO_MODE:
                    raw = MK.demo_raw(days + 1)
                    update({"progress": [1, 1]})
                else:
                    raw = MK.collect(days + 1, token, allow_network=True,
                                     progress=lambda n, t, label: update({"progress": [n, max(t, 1)]}))
                warnings = T.TC.public_info()["warnings"]
                errs = T.TC.public_info().get("errors") or {}
            if not raw:
                why = "；".join("%s：%s" % (h, r) for h, r in errs.items() if "twse" in h or "tpex" in h)
                raise ValueError("取不到全市場資料" + ("（" + why + "）" if why else "") + "。可按「連線檢查」查看各來源的狀態。")
            raw["_warnings"], raw["_days"] = warnings[:], days
            with _lock:
                _market["raw"], _market["results"], _market["days"] = raw, {}, days
            res = _market_result(min_amount)
            update({"status": "done", "stage": "完成", "detail": "掃描完成", "data": res})
        except Exception as e:                                          # noqa: BLE001
            msg = str(e) if isinstance(e, ValueError) else "市場掃描失敗，請稍後重試。"
            update({"status": "error", "stage": "失敗", "error": msg})
    _market_pool.submit(worker)
    return job_id


def market_quote(code):
    """警示與模擬持倉用的最新報價：先看全市場掃描，再看剛分析過的個股。"""
    with _lock:
        s = _market["by"].get(code)
        latest = None
        for key, hit in _cache.items():
            if key[0] == code and hit["raw"] and hit["raw"].get("bars"):
                b = hit["raw"]["bars"][-1]
                if latest is None or b["date"] > latest["date"]:
                    prev = hit["raw"]["bars"][-2]["close"] if len(hit["raw"]["bars"]) > 1 else None
                    latest = {"date": b["date"], "close": b["close"], "high": b["high"], "low": b["low"],
                              "chg_pct": T.r2((b["close"] / prev - 1) * 100) if prev else None,
                              "name": hit["raw"].get("name"), "source": "個股分析"}
        mdate = _market.get("latest")
    if s and mdate and (latest is None or mdate >= latest["date"]):
        return {"date": mdate, "close": s["close"], "high": s["high"], "low": s["low"],
                "chg_pct": s["chg_pct"], "name": s["name"], "source": "市場掃描"}
    return latest


def alerts_view():
    with _lock:
        alerts = MK.load_alerts()
    return MK.evaluate_alerts(alerts, market_quote)


def portfolio():
    with _lock:
        pf = MK.load_portfolio()
    return MK.portfolio_view(pf, market_quote)


MAX_GROUPS = T.MAX_GROUPS
MAX_PER_GROUP = T.MAX_PER_GROUP


def _group_name(name):
    name = (name or "").strip()
    if not 1 <= len(name) <= 30 or any(ord(ch) < 32 for ch in name):
        raise ValueError("群組名稱請填 1～30 個字")
    return name


def _codes(codes_text):
    codes = []
    for part in re.split(r"[,，、\s]+", codes_text or ""):
        if part:
            code = _clean_code(part)
            if code not in codes:
                codes.append(code)
    return codes


def save_group(name, codes_text):
    """整組覆寫。"""
    name = _group_name(name)
    codes = _codes(codes_text)
    if not 1 <= len(codes) <= MAX_PER_GROUP:
        raise ValueError("每個群組請放 1～%d 檔股票" % MAX_PER_GROUP)
    with _lock:
        groups = load_groups()
        if name not in groups and len(groups) >= MAX_GROUPS:
            raise ValueError("群組數量已達上限（%d 個），請先刪除一個" % MAX_GROUPS)
        groups[name] = codes
        T.save_watchlists(groups)
    return groups


def edit_group(name, add="", remove=""):
    """在既有群組裡加、減個股（群組不存在時，加入即建立）。"""
    name = _group_name(name)
    adds, removes = _codes(add), _codes(remove)
    if not adds and not removes:
        raise ValueError("請輸入要加入或移除的股票代號")
    with _lock:
        groups = load_groups()
        if name not in groups:
            if removes and not adds:
                raise ValueError("找不到這個群組")
            if len(groups) >= MAX_GROUPS:
                raise ValueError("群組數量已達上限（%d 個），請先刪除一個" % MAX_GROUPS)
        codes = [c for c in groups.get(name, []) if c not in removes]
        for c in adds:
            if c not in codes:
                codes.append(c)
        if len(codes) > MAX_PER_GROUP:
            raise ValueError("每個群組最多 %d 檔，「%s」放不下了；請先移除幾檔" % (MAX_PER_GROUP, name))
        if not codes:
            del groups[name]
        else:
            groups[name] = codes
        T.save_watchlists(groups)
    return groups


def delete_group(name):
    with _lock:
        groups = load_groups()
        if name not in groups:
            raise ValueError("找不到這個群組")
        del groups[name]
        T.save_watchlists(groups)
    return groups


DATA_COLS = [("日期", "date"), ("開盤", "open"), ("最高", "high"), ("最低", "low"),
             ("收盤", "close"), ("成交量(張)", "vol"),
             ("MA5", "ma5"), ("MA10", "ma10"), ("MA20", "ma20"), ("MA60", "ma60"),
             ("K", "k"), ("D", "d"), ("RSI14", "rsi"),
             ("ADX14", "adx"), ("+DI14", "plus_di"), ("-DI14", "minus_di"),
             ("布林中軌20", "bb_mid"), ("布林上軌2σ", "bb_upper"), ("布林下軌2σ", "bb_lower"),
             ("布林%B", "bb_percent_b"), ("布林寬度%", "bb_width"), ("寬度120日百分位", "bb_width_rank"),
             ("MACD_DIF", "dif"), ("MACD訊號", "sig"), ("MACD_OSC", "osc"),
             ("外資(張)", "chip_foreign"), ("投信(張)", "chip_trust"),
             ("自營商(張)", "chip_dealer"), ("三大法人(張)", "chip_total")]


def _metadata(d):
    return [("資料來源", d["source"]), ("產生時間", d["generated"]),
                ("股價最新日期", d["last_date"]),
                ("法人最新日期", d["avail"]["chip_latest"]),
                ("融資券最新日期", d["avail"]["margin_latest"]),
                ("報酬口徑", "價格報酬（不含息）"),
                ("計分版本", d.get("score_model", "")),
                ("大盤基準", (d.get("bench") or {}).get("name", "未取得")),
                ("除權息確認", (d.get("dividends") or {}).get("status", "unavailable")),
                ("布林參數", "20日/2倍母體標準差"),
                ("要求交易日數", d["avail"]["need_days"])]


def to_csv(d):
    s = d["series"]
    cols = DATA_COLS
    metadata = _metadata(d)
    buf = io.StringIO(newline="")
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow([c[0] for c in cols] + [m[0] for m in metadata])
    for i in range(len(s["date"])):
        writer.writerow([s[k][i] for _, k in cols] + [m[1] for m in metadata])
    return buf.getvalue()


def _patterns_by_date(d):
    """主K線圖視窗內每天出現的 K 線型態名稱（Excel 的「K 線型態」欄）。"""
    p, k = d.get("patterns") or {}, d.get("kline") or {}
    names = {x["key"]: x["name"] for x in p.get("defs", [])}
    dates = k.get("date") or []
    out = {}
    for e in p.get("events", []):
        if 0 <= e["i"] < len(dates):
            out.setdefault(dates[e["i"]], []).append(names.get(e["key"], e["key"]))
    return out


def to_xlsx(payloads):
    """0930a：這次分析的全部股票放進同一個 Excel 檔：第一張「總覽」，之後每檔一張工作表。"""
    def g(obj, *keys):
        for key in keys:
            obj = obj.get(key) if isinstance(obj, dict) else None
        return obj
    overview_cols = [("代號", 9), ("名稱", 14), ("市場", 7), ("股價最新日期", 12), ("收盤", 10), ("漲跌", 9), ("漲跌幅%", 9),
                     ("成交量(張)", 12), ("綜合分", 8), ("技術分", 8), ("籌碼分", 8), ("研判", 18),
                     ("法人近5日(張)", 13), ("法人近20日(張)", 13), ("相對大盤20日(點)", 13),
                     ("布林%B", 9), ("布林寬度%", 10), ("ADX14", 8), ("最近 K 線型態", 22),
                     ("顯示天數", 8), ("法人最新日期", 12), ("融資券最新日期", 13), ("除權息確認", 10), ("大盤基準", 18), ("資料來源", 12)]
    status = {"confirmed": "已確認", "unavailable": "未取得"}
    rows, sheets = [], []
    for d in payloads:
        pat = _patterns_by_date(d)
        recent = [dt_ + " " + "、".join(v) for dt_, v in sorted(pat.items())[-3:]]
        rows.append([d["code"], d.get("name"), {"twse": "上市", "tpex": "上櫃"}.get(d.get("market"), d.get("market") or ""),
                     d["last_date"], g(d, "quote", "close"), g(d, "quote", "chg"), g(d, "quote", "chg_pct"),
                     g(d, "quote", "vol"), g(d, "scores", "overall"), g(d, "scores", "tech"), g(d, "scores", "chip"),
                     g(d, "plan", "verdict"), g(d, "chip", "net5"), g(d, "chip", "net20"), g(d, "bench", "d20", "rs"),
                     g(d, "bollinger", "percent_b"), g(d, "bollinger", "width"), g(d, "dmi", "adx"),
                     "；".join(recent) or "—", d.get("bars_count"), g(d, "avail", "chip_latest"),
                     g(d, "avail", "margin_latest"), status.get(g(d, "dividends", "status") or "unavailable", g(d, "dividends", "status")),
                     g(d, "bench", "name") or "未取得", d.get("source")])
        s = d["series"]
        header = [c[0] for c in DATA_COLS] + ["K 線型態"]
        data = [[s[k][i] for _, k in DATA_COLS] + ["、".join(pat.get(s["date"][i], []))] for i in range(len(s["date"]))]
        sheets.append({"name": "%s %s" % (d["code"], d.get("name") or ""), "header": header, "rows": data,
                       "widths": [12] + [10] * (len(DATA_COLS) - 1) + [20],
                       "notes": ["%s：%s" % (k, "" if v is None else status.get(v, v) if k == "除權息確認" else v)
                                 for k, v in _metadata(d)]})
    app = T.APP_TITLE
    overview = {"name": "總覽", "header": [c[0] for c in overview_cols], "rows": rows, "widths": [c[1] for c in overview_cols],
                "notes": ["%s　產生時間 %s　共 %d 檔；每檔的日K與指標在後面各自的工作表（顯示分析天數內的交易日）。"
                          % (app, time.strftime("%Y-%m-%d %H:%M"), len(payloads)),
                          "分數都是規則計分，不是勝率也不是投資建議；價格未還原，報酬為價格報酬（不含息）。空白＝資料不足或未取得。"]}
    return twxlsx.workbook([overview] + sheets, title=app, author=T.APP_CREDIT)


def export_strategy(q):
    text = q.get("strategy", [""])[0]
    if not text:
        return None
    if len(text) > 2000:
        raise ValueError("回測設定過長")
    obj = json.loads(text)
    limits = {"threshold": (0, 100), "hold": (1, 60), "fee": (0, 5), "tax": (0, 5), "slip": (0, 5)}
    allowed = set(limits) | {"signal", "segment", "start", "end", "require_chip"}
    if not isinstance(obj, dict) or not set(obj).issubset(allowed):
        raise ValueError("回測設定無效")
    for key, (lo, hi) in limits.items():
        if key in obj:
            v = obj[key]
            if type(v) not in (int, float) or not lo <= v <= hi or (key == "hold" and int(v) != v):
                raise ValueError("回測數值無效")
    if "signal" in obj and obj["signal"] not in ("score", "bb", "both"):
        raise ValueError("回測規則無效")
    if "segment" in obj and obj["segment"] not in ("all", "early", "late"):
        raise ValueError("回測區間無效")
    if "require_chip" in obj and type(obj["require_chip"]) is not bool:
        raise ValueError("法人設定無效")
    for key in ("start", "end"):
        value = obj.get(key, "")
        if not isinstance(value, str) or (value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
            raise ValueError("回測日期無效")
    if obj.get("start") and obj.get("end") and obj["start"] > obj["end"]:
        raise ValueError("回測日期無效")
    return obj


def save_snapshot(d):
    snapshot = secrets.token_urlsafe(24)
    d["snapshot_id"] = snapshot
    with _lock:
        _snapshots[snapshot] = d
        while len(_snapshots) > MAX_SNAPSHOTS:
            _snapshots.popitem(last=False)
    return d


def get_snapshot(q):
    with _lock:
        d = _snapshots.get(q.get("snapshot", [""])[0])
    if d is None:
        raise ValueError("此分析快照已失效，請重新產生圖表後下載；不會自動改抓新資料。")
    return d



def echarts_tag(inline):
    if inline:
        return T.load_echarts("inline")
    p = os.path.join(HERE, "echarts.min.js")
    if os.path.exists(p):
        return '<script src="/echarts.min.js"></script>'
    return ('<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/'
            'dist/echarts.min.js"></script>')


# --------------------------------------------------------------------------

LEGAL_FILES = {"/LICENSE": "LICENSE", "/LICENSE-EXCEPTION": "LICENSE-EXCEPTION.md",
               "/THIRD-PARTY-NOTICES": "THIRD-PARTY-NOTICES.md"}


class Handler(BaseHTTPRequestHandler):
    server_version = "twboard/" + T.APP_VERSION

    def log_message(self, fmt, *a):
        if self.path.startswith("/api/") and not self.path.startswith(("/api/jobs/", "/api/usage")):     # 輪詢的請求不洗版
            sys.stderr.write("  %s %s\n" % (self.command, urllib.parse.urlsplit(self.path).path))

    # ---- 回應工具 ----
    def _send(self, code, ctype, body, extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False, allow_nan=False))

    def _attach(self, name, ctype, body, ascii_name=None):
        """中文檔名用 RFC 5987 的 filename*，同時附一個純 ASCII 的 filename 作後備，
        因為有些瀏覽器／下載工具只看得懂後者。"""
        fb = ascii_name or re.sub(r"[^A-Za-z0-9._-]", "_", name) or "download"
        self._send(200, ctype, body, {
            "Content-Disposition": 'attachment; filename="%s"; filename*=UTF-8\'\'%s'
                                   % (fb, urllib.parse.quote(name))})

    def _local_request(self):
        port = self.server.server_address[1]
        valid = {"127.0.0.1:%d" % port, "localhost:%d" % port}
        if self.headers.get("Host", "") not in valid:
            self._json({"ok": False, "error": "僅接受本機存取"}, 403)
            return False
        return True

    def do_POST(self):
        global SESSION_TOKEN
        if not self._local_request():
            return
        path = urllib.parse.urlsplit(self.path).path
        try:
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                return self._json({"ok": False, "error": "不接受其他網站的請求"}, 403)
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("請使用 JSON 請求")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 65536:
                raise ValueError("請求大小不正確")
            obj = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(obj, dict) or any(not isinstance(v, (str, int)) for v in obj.values()):
                raise ValueError("請求格式不正確")
            if path == "/api/token":
                with _lock:
                    SESSION_TOKEN = str(obj.get("token", ""))
                return self._json({"ok": True})
            if path in ("/api/filter-presets", "/api/filter-presets/delete"):
                filters_text = obj.get("filters", "{}")
                if not isinstance(filters_text, str):
                    raise ValueError("篩選條件格式不正確")
                with _lock:
                    presets = C.update_preset(obj.get("name", ""),
                        json.loads(filters_text), delete=path.endswith("/delete"))
                return self._json({"ok": True, "presets": presets})
            if path == "/api/watchlists":
                return self._json({"ok": True, "groups": save_group(str(obj.get("name", "")), str(obj.get("codes", "")))})
            if path == "/api/watchlists/edit":
                return self._json({"ok": True, "groups": edit_group(str(obj.get("name", "")),
                                                                     str(obj.get("add", "")), str(obj.get("remove", "")))})
            if path == "/api/watchlists/delete":
                return self._json({"ok": True, "groups": delete_group(str(obj.get("name", "")))})
            if path == "/api/jobs":
                q = {k: [str(v)] for k, v in obj.items() if k != "token"}
                return self._json({"ok":True,"job_id":start_job(q)},202)
            if path == "/api/market/scan":
                return self._json({"ok": True, "job_id": start_market_scan({k: [str(v)] for k, v in obj.items()})}, 202)
            if path == "/api/themes":
                try:
                    items = json.loads(str(obj.get("themes", "[]")))
                except ValueError:
                    raise ValueError("族群資料格式不正確") from None
                with _lock:
                    themes = MK.save_themes(items)
                    _market["results"] = {}
                return self._json({"ok": True, "themes": themes, "custom": True, "names": theme_names(themes)})
            if path == "/api/themes/reset":
                with _lock:
                    try:
                        os.replace(MK.data_path("themes.json"), MK.data_path("themes.json.bak"))
                    except FileNotFoundError:
                        pass
                    _market["results"] = {}
                themes, custom = MK.load_themes()
                return self._json({"ok": True, "themes": themes, "custom": custom, "names": theme_names(themes)})
            if path == "/api/alerts":
                with _lock:
                    MK.save_alert(obj.get("code"), obj.get("above"), obj.get("below"), obj.get("pct"), obj.get("note", ""))
                return self._json({"ok": True, "alerts": alerts_view()})
            if path == "/api/alerts/delete":
                with _lock:
                    MK.delete_alert(obj.get("code"))
                return self._json({"ok": True, "alerts": alerts_view()})
            if path == "/api/alerts/ack":
                with _lock:
                    MK.ack_alerts(str(obj.get("date", ""))[:10])
                return self._json({"ok": True, "alerts": alerts_view()})
            if path == "/api/portfolio/buy":
                with _lock:
                    MK.paper_buy(obj.get("code"), obj.get("price"), obj.get("lots", "1"), obj.get("date", ""), obj.get("name", ""))
                return self._json({"ok": True, "portfolio": portfolio()})
            if path == "/api/portfolio/sell":
                with _lock:
                    MK.paper_sell(str(obj.get("id", "")), obj.get("price"), obj.get("date", ""))
                return self._json({"ok": True, "portfolio": portfolio()})
            if path == "/api/portfolio/delete":
                with _lock:
                    MK.paper_delete(str(obj.get("id", "")), str(obj.get("which", "open")))
                return self._json({"ok": True, "portfolio": portfolio()})
            if path == "/api/cache/clear":
                if obj.get("confirm") != "yes":
                    raise ValueError("請再確認一次")
                return self._json({"ok": True, "data": clear_cache()})
            if path == "/api/analyse":
                q = {k: [str(v)] for k, v in obj.items() if k != "token"}
                return self._json({"ok": True, "data": save_snapshot(get_payload(q))})
            return self._json({"ok": False, "error": "找不到此功能"}, 404)
        except (ValueError, UnicodeError) as e:
            # 不回傳輸入內容，避免憑證出現在錯誤訊息。群組相關訊息是固定字串，不含輸入，可原樣顯示。
            if path.startswith(("/api/watchlists", "/api/filter-presets", "/api/themes", "/api/alerts",
                                "/api/portfolio", "/api/market", "/api/cache")) and isinstance(e, ValueError):
                return self._json({"ok": False, "error": str(e)}, 400)
            return self._json({"ok": False, "error": "請求或資料無效，請確認股票代號與設定。"}, 400)
        except Exception:
            return self._json({"ok": False, "error": "分析失敗，請稍後重試。"}, 500)

    # ---- 路由 ----
    def do_GET(self):
        if not self._local_request():
            return
        u = urllib.parse.urlparse(self.path)
        path, q = u.path, urllib.parse.parse_qs(u.query)
        try:
            if "token" in q:
                return self._json({"ok": False, "error": "Token 不接受透過網址傳送，請更新頁面。"}, 400)
            if path in ("/", "/index.html"):
                return self._send(200, "text/html; charset=utf-8",
                                  T.assemble(T._part("board_app.html"), echarts_tag(False)))

            if path == "/echarts.min.js":
                p = os.path.join(HERE, "echarts.min.js")
                if not os.path.exists(p):
                    return self._send(404, "text/plain; charset=utf-8", "not found")
                with open(p, "rb") as f:
                    return self._send(200, "application/javascript; charset=utf-8", f.read(),
                                      {"Cache-Control": "public, max-age=86400"})

            if path in LEGAL_FILES:
                p = os.path.join(HERE, LEGAL_FILES[path])
                if not os.path.exists(p):
                    return self._send(404, "text/plain; charset=utf-8", "找不到授權檔 %s，請確認它和程式放在同一個資料夾。" % LEGAL_FILES[path])
                with open(p, "rb") as f:
                    return self._send(200, "text/plain; charset=utf-8", f.read())

            if path == "/favicon.ico":
                svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
                       '<rect width="16" height="16" rx="3" fill="#151a24"/>'
                       '<path d="M3 11l3-3 2.5 2L13 5" stroke="#3987e5" stroke-width="1.8" '
                       'fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')
                return self._send(200, "image/svg+xml", svg,
                                  {"Cache-Control": "public, max-age=86400"})

            if path == "/api/filter-presets":
                try:
                    with _lock:
                        presets = C.load_presets()
                    return self._json({"ok": True, "presets": presets})
                except ValueError as e:
                    return self._json({"ok": False, "error": str(e)}, 400)

            if path == "/api/watchlists":
                return self._json({"ok": True, "groups": load_groups(),
                                   "limits": {"groups": MAX_GROUPS, "per_group": MAX_PER_GROUP}})

            if path == "/api/macro":
                return self._json({"ok": True, "data": get_macro(q)})
            if path == "/api/market":
                return self._json({"ok": True, "data": get_market(q)})
            if path == "/api/power":
                return self._json({"ok": True, "data": get_power(q)})
            if path == "/api/themes":
                themes, custom = MK.load_themes()
                return self._json({"ok": True, "themes": themes, "custom": custom, "names": theme_names(themes)})
            if path == "/api/alerts":
                return self._json({"ok": True, "alerts": alerts_view()})
            if path == "/api/portfolio":
                return self._json({"ok": True, "portfolio": portfolio()})
            if path == "/api/diagnose":
                if DEMO_MODE:
                    return self._json({"ok": True, "data": {"checks": [], "demo": True}})
                with _lock:
                    token = DEFAULT_TOKEN if SESSION_TOKEN is None else SESSION_TOKEN
                return self._json({"ok": True, "data": MK.diagnose(token, yahoo=q.get("yahoo", ["0"])[0] == "1")})

            if path == "/api/health":
                return self._json({"ok": True, "version": self.server_version})
            if path == "/api/usage":
                return self._json({"ok": True, "data": usage_view(q)})

            if path.startswith("/api/jobs/"):
                return self._json({"ok":True,"job":job_status(path.rsplit("/",1)[-1])})
            if path == "/api/analyse":
                return self._json({"ok": False, "error": "請重新載入頁面並使用 POST 分析。"}, 405)

            if path.startswith("/api/export"):
                d = dict(get_snapshot(q))
                settings = export_strategy(q)
                if settings is not None:
                    d["strategy_settings"] = settings
                macro_id = q.get("macro_snapshot", [""])[0]
                macro = None
                if macro_id:
                    with _lock:
                        macro = copy.deepcopy(_macro_snapshots.get(macro_id))
                    if macro is None:
                        raise ValueError("市場快照已失效，請先更新市場面板再匯出；不會替換為其他市場資料。")
                html = T.render(dict(d, macro=macro), echarts_tag(True))
                return self._attach("%s_%s_戰略圖.html" % (d["code"], d["name"]),
                                    "text/html; charset=utf-8", html,
                                    "%s_board.html" % d["code"])

            if path.startswith("/api/xlsx"):
                ids = [x for x in q.get("snapshots", [""])[0].split(",") if x][:10]
                if not ids:
                    raise ValueError("沒有可以下載的股票，請先產生圖表。")
                payloads = [get_snapshot({"snapshot": [i]}) for i in ids]
                day = max(p["last_date"] for p in payloads)
                return self._attach("個股資料_%s_%d檔.xlsx" % (day, len(payloads)),
                                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                    to_xlsx(payloads), "twboard_data_%s.xlsx" % day)

            if path.startswith("/api/csv"):
                d = get_snapshot(q)
                return self._attach("%s_%s_資料.csv" % (d["code"], d["name"]),
                                    "text/csv; charset=utf-8", to_csv(d),
                                    "%s_data.csv" % d["code"])

            return self._send(404, "text/plain; charset=utf-8", "not found")

        except ValueError as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        except Exception as e:                                  # noqa: BLE001
            return self._json({"ok": False, "error": "伺服器錯誤，請稍後重試。"}, 500)


def free_port(start, tries=25):
    for p in range(start, start + tries):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit("找不到可用的埠號（%d~%d 都被占用）" % (start, start + tries))


def main():
    global DEFAULT_TOKEN
    ap = argparse.ArgumentParser(description=T.APP_TITLE+" — 本機互動版")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--token", default=os.environ.get("FINMIND_TOKEN", ""),
                    help="預先填入的 FinMind token（頁面上仍可覆寫）")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--demo", action="store_true",
                    help="用合成資料跑，不連網，純粹試操作介面")
    a = ap.parse_args()
    DEFAULT_TOKEN = a.token
    globals()["DEMO_MODE"] = a.demo

    for f in ("twboard.py", "board_app.html", "board.css", "board_body.html", "board.js", "board_template.html",
              "twcache.py", "twmacro.py", "twmarket.py", "twpattern.py", "twpower.py", "twusage.py", "twxlsx.py", "glossary.js",
              "market.js", "power.js", "usage.js"):
        if not os.path.exists(os.path.join(HERE, f)):
            raise SystemExit("缺少檔案 %s，請確認所有檔案都放在同一個資料夾。" % f)

    removed = T.TC.prune()
    if removed:
        print("  已清除 %d 筆用不到的舊快取" % removed)

    port = free_port(a.port)
    url = "http://127.0.0.1:%d" % port
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)

    print("\n  "+T.APP_TITLE+"已啟動")
    print("  "+T.APP_CREDIT)
    print("  " + T.legal_text().replace("\n", "\n  "))
    print("  %s" % url)
    if not os.path.exists(os.path.join(HERE, "echarts.min.js")):
        print("  ! 找不到 echarts.min.js，圖表會改從網路載入")
    if a.demo:
        print("  ** 示範模式：使用合成資料，不會連網 **")
    print("  按 Ctrl+C 結束\n")

    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
        srv.shutdown()


if __name__ == "__main__":
    main()
