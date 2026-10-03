# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""
API 用量與連線狀態（1003a）：畫面角落的「資料來源」小視窗用。

* 每一次真正送出的網路請求都會經過 twboard.http_get_json，在這裡記下：哪個來源、查什麼、花多久、成功或失敗的原因。
* FinMind 的查詢次數另外寫進本機資料庫（usage_log 表），重開程式也知道這一小時已經用了幾次。
* 有填 FinMind Token 時，最多每分鐘向 FinMind 查一次官方用量（user_info，不算在額度內）；沒有 Token 就用本程式的紀錄估算。
* 不記錄 Token、不記錄完整網址；「查什麼」只留資料集名稱與股票代號。
"""
import itertools
import json
import threading
import time
import urllib.parse
import urllib.request

import twcache as TC

FINMIND = "FinMind"
ORDER = (FINMIND, "證交所", "櫃買中心", "集保結算所", "Stooq", "Yahoo 財經")
HOSTS = {
    "api.finmindtrade.com": FINMIND, "api.web.finmindtrade.com": FINMIND,
    "www.twse.com.tw": "證交所", "openapi.twse.com.tw": "證交所", "twse.com.tw": "證交所",
    "www.tpex.org.tw": "櫃買中心", "tpex.org.tw": "櫃買中心",
    "smart.tdcc.com.tw": "集保結算所", "opendata.tdcc.com.tw": "集保結算所",
    "stooq.com": "Stooq", "stooq.pl": "Stooq",
    "query1.finance.yahoo.com": "Yahoo 財經", "query2.finance.yahoo.com": "Yahoo 財經",
}
FINMIND_LIMIT = {False: 300, True: 600}        # 官方：未登入 300 次／小時，免費註冊 Token 600 次／小時
USER_INFO_URL = "https://api.web.finmindtrade.com/v2/user_info"
USER_INFO_EVERY = 60                           # 官方用量最多每 60 秒查一次
SLOW_AFTER = 8.0                               # 等超過 8 秒標「回應緩慢」
WINDOW = 3600

_lock = threading.Lock()
_extra_hosts = {}                              # 進階設定改過的 FinMind 網址 → 仍算 FinMind
_stats = {}                                    # 來源 → 統計
_inflight = {}                                 # 請求編號 → 進行中的請求
_seq = itertools.count(1)
_official = {"at": 0.0, "token": None, "data": None, "data_at": None, "error": None, "busy": False}


def register(url, label):
    """自訂 API 網址（例如換成 FinMind 的鏡像）也歸到原來的來源。"""
    host = urllib.parse.urlsplit(url or "").netloc.lower()
    if host and host not in HOSTS:
        with _lock:
            _extra_hosts[host] = label


def source_of(url):
    host = urllib.parse.urlsplit(url or "").netloc.lower()
    with _lock:
        return HOSTS.get(host) or _extra_hosts.get(host) or host or "其他"


def describe(url, params):
    """畫面上「正在查什麼」：FinMind 寫資料集與代號，其他來源寫網址最後一段；不含 Token 與完整查詢參數。"""
    params = params or {}
    if params.get("dataset"):
        what = str(params["dataset"])
        if params.get("data_id"):
            what += " " + str(params["data_id"])
        return what
    path = urllib.parse.urlsplit(url or "").path.rstrip("/")
    tail = path.rsplit("/", 1)[-1] if path else ""
    extra = params.get("date") or params.get("s") or ""
    return (tail + (" " + str(extra) if extra else "")).strip() or "資料"


def _stat(label):
    s = _stats.get(label)
    if s is None:
        s = _stats[label] = {"requests": 0, "ok": 0, "fail": 0, "last_ok": None, "last_fail": None,
                             "last_error": None, "last_status": None, "streak": 0, "avg_ms": None,
                             "quota_at": None, "blocked_at": None, "recent": []}
    return s


def begin(url, params=None, count=True):
    label = source_of(url)
    rid = next(_seq)
    with _lock:
        _inflight[rid] = {"source": label, "what": describe(url, params), "start": time.time(), "count": count}
    return rid


def end(rid, ok, status=None, error=None):
    """請求結束：status 是 HTTP 狀態碼（連線失敗時為 None），error 是看得懂的原因。"""
    now = time.time()
    with _lock:
        item = _inflight.pop(rid, None)
        if item is None:
            return
        s = _stat(item["source"])
        ms = (now - item["start"]) * 1000.0
        s["requests"] += 1
        s["recent"] = [t for t in s["recent"] if now - t < WINDOW] + [now]
        s["avg_ms"] = ms if s["avg_ms"] is None else s["avg_ms"] * 0.8 + ms * 0.2
        if ok:
            s["ok"] += 1
            s["last_ok"], s["streak"] = now, 0
        else:
            s["fail"] += 1
            s["last_fail"], s["streak"] = now, s["streak"] + 1
            s["last_error"], s["last_status"] = error or "未知原因", status
            if status in (402, 429):
                s["quota_at"] = now
            if status == 403:
                s["blocked_at"] = now
        reached = ok or status is not None          # 有收到回應才算用了對方的額度；連不上的不算
        log_it = item["count"] and item["source"] == FINMIND and reached
    if log_it:
        TC.log_request(FINMIND, ok, status, now)


def reset():
    """測試用：清掉記憶體裡的統計。"""
    with _lock:
        _stats.clear(); _inflight.clear(); _extra_hosts.clear()
        _official.update({"at": 0.0, "token": None, "data": None, "data_at": None, "error": None, "busy": False})


# --------------------------------------------------------------------------
# FinMind 官方用量（有 Token 才查）
# --------------------------------------------------------------------------

def _fetch_official(token):
    import twboard as T            # 延後匯入，避免循環相依
    req = urllib.request.Request(USER_INFO_URL, headers={"User-Agent": T.UA, "Accept": "application/json",
                                                         "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=10, context=T._SSL_CTX) as r:
            j = json.loads(r.read().decode("utf-8", errors="replace"))
        used, limit = j.get("user_count"), j.get("api_request_limit")
        if isinstance(used, (int, float)) and isinstance(limit, (int, float)) and limit > 0:
            data, error = {"used": int(used), "limit": int(limit)}, None
        else:
            data, error = None, "官方用量格式不符"
    except Exception as e:          # noqa: BLE001
        data, error = None, T.describe_error(e)
    with _lock:
        if _official["token"] == token:
            # 查不到時保留上一筆官方數字（畫面會標示時間），超過 10 分鐘就改用本機估算。
            _official.update({"data": data or _official["data"], "data_at": time.time() if data else _official.get("data_at"),
                              "error": error, "at": time.time(), "busy": False})


def refresh_official(token, wait=False, force=False):
    """背景更新官方用量；回傳目前已知的值。換了 Token 就丟掉舊值。"""
    if not token:
        return None
    with _lock:
        if _official["token"] != token:
            _official.update({"token": token, "data": None, "data_at": None, "error": None, "at": 0.0, "busy": False})
        due = force or time.time() - _official["at"] >= USER_INFO_EVERY
        start = due and not _official["busy"]
        if start:
            _official["busy"] = True
    if start:
        if wait:
            _fetch_official(token)
        else:
            threading.Thread(target=_fetch_official, args=(token,), daemon=True, name="twboard-usage").start()
    with _lock:
        return dict(_official)


# --------------------------------------------------------------------------
# 畫面資料
# --------------------------------------------------------------------------

def _state(label, s, inflight, now):
    """狀態：idle 未使用、ok 正常、busy 讀取中、slow 回應緩慢、limit 額度用完、blocked 被拒、error 連線失敗。"""
    waiting = [i for i in inflight if i["source"] == label]
    slow = [i for i in waiting if now - i["start"] >= SLOW_AFTER]
    if s is None:
        return ("slow" if slow else "busy") if waiting else "idle"
    after_ok = lambda t: t is not None and (s["last_ok"] is None or t > s["last_ok"])
    if s["quota_at"] and now - s["quota_at"] < WINDOW and after_ok(s["quota_at"]):
        return "limit"
    if slow:
        return "slow"
    if waiting:
        return "busy"
    if s["blocked_at"] and now - s["blocked_at"] < WINDOW and after_ok(s["blocked_at"]):
        return "blocked"
    if s["last_fail"] and after_ok(s["last_fail"]):
        return "error"
    return "ok" if s["last_ok"] else "idle"


def snapshot(token="", fetch_official=True):
    now = time.time()
    with _lock:
        inflight = [dict(v) for v in _inflight.values()]
        stats = {k: dict(v, recent=list(v["recent"])) for k, v in _stats.items()}
    official = refresh_official(token) if (token and fetch_official) else None
    log = TC.request_log(FINMIND, now - WINDOW)
    local_used = len(log)
    has_token = bool(token)
    data = (official or {}).get("data")
    if data and now - ((official or {}).get("data_at") or 0) > 600:
        data = None
    if data:
        used, limit, basis = data["used"], data["limit"], "official"
    else:
        used, limit, basis = local_used, FINMIND_LIMIT[has_token], "local"
    s = stats.get(FINMIND)
    quota_at = s["quota_at"] if s and s["quota_at"] and now - s["quota_at"] < WINDOW else None
    finmind = {
        "used": used, "limit": limit, "remaining": max(0, limit - used), "basis": basis, "token": has_token,
        "local_used": local_used, "official_at": (official or {}).get("data_at") if data else None,
        "official_error": (official or {}).get("error"),
        "first_in_window": log[0] if log else None, "quota_at": quota_at,
        "pct": round(min(100.0, used * 100.0 / limit), 1) if limit else None,
    }
    sources = []
    names = list(ORDER) + sorted(k for k in set(stats) | {i["source"] for i in inflight} if k not in ORDER)
    for label in names:
        st = stats.get(label)
        waiting = sorted((i for i in inflight if i["source"] == label), key=lambda i: i["start"])
        item = {"name": label, "state": _state(label, st, inflight, now),
                "inflight": [{"what": i["what"], "seconds": round(now - i["start"], 1)} for i in waiting]}
        if st:
            item.update({"requests": st["requests"], "hour": len(st["recent"]), "ok": st["ok"], "fail": st["fail"],
                         "last_ok": st["last_ok"], "last_fail": st["last_fail"], "error": st["last_error"],
                         "status": st["last_status"], "streak": st["streak"],
                         "avg_ms": round(st["avg_ms"]) if st["avg_ms"] is not None else None})
        if label == FINMIND:
            item["hour"] = local_used
        sources.append(item)
    act = TC.activity(now - WINDOW)
    total = act["cache"] + act["network"]
    return {"now": now, "finmind": finmind, "sources": sources,
            "busy": bool(inflight),
            "cache": dict(TC.stats_detail(), hits_hour=act["cache"], net_hour=act["network"],
                          saved_pct=round(act["cache"] * 100.0 / total) if total else None,
                          rules=TC.RULES_TEXT)}
