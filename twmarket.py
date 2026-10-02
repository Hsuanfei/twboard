# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""全市場掃描（20260925a）：上市櫃每日行情 → 選股清單、漲幅排行、熱門 ETF、族群輪動。

資料來源（皆為免 Token 的官方公開資料，逐日一個請求、存在本機快取）：
  上市日行情   證交所 MI_INDEX（type=ALLBUT0999，不含權證）
  上市法人     證交所 T86（與個股分析共用快取）
  上櫃日行情   櫃買中心 每日收盤行情（新版網址失敗時自動改用舊版網址）
  上櫃法人     櫃買中心 三大法人買賣明細（同上）
  產業別       FinMind TaiwanStockInfo（一次取得全部股票；取不到時只有概念族群）

第一次掃描要逐日下載約 90 個平日的全市場資料，為了不被證交所擋下，每個請求間隔約 2 秒，
所以需要幾分鐘；之後每天只補新的一天。各來源若改版導致格式看不懂，會把回應的開頭記在
market_debug.log（不含 Token），方便回報。

所有清單都是把公開資料套進固定規則的篩選結果，不是投資建議。
"""
import datetime as _dt
import json
import math
import os
import random
import re
import statistics
import threading
import time
import urllib.parse
import zlib

import twboard as T
import twcache as TC

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- 端點：來源改版時改這裡 ----
TWSE_ALL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
TPEX_DAY = ("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes",
            "https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php")
TPEX_INSTI = ("https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade",
              "https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php")

INTERVAL = {"www.twse.com.tw": 2.2, "www.tpex.org.tw": 1.6}     # 同一個網站兩次請求至少間隔幾秒
CHIP_DAYS = 10            # 法人連買最多往回看幾個交易日
SCAN_DAYS = (20, 60)      # 可選的掃描期間（交易日）
MIN_MEMBERS = 3           # 族群至少幾檔才計算
STOCK_RE = re.compile(r"^[1-9]\d{3}$")          # 一般股票：四位數字、不以 0 開頭
ETF_RE = re.compile(r"^00\d{2,4}[A-Z]?$")       # ETF：00 開頭
MAX_THEMES, MAX_THEME_CODES = 40, 60


def data_path(name):
    return os.path.join(os.environ.get("TWBOARD_DATA_DIR") or HERE, name)


# ==========================================================================
# 預設概念族群（範例，可在畫面上編輯；存到 themes.json 後以使用者的版本為準）
# ==========================================================================
DEFAULT_THEMES = [
    {"name": "AI 伺服器", "codes": ["2382", "3231", "6669", "2317", "2356", "2376", "3706"]},
    {"name": "散熱模組", "codes": ["3017", "3324", "2421", "3653", "6230", "8996", "3338"]},
    {"name": "先進封裝 CoWoS", "codes": ["2330", "3711", "3131", "3583", "6187", "6640", "2467"]},
    {"name": "矽智財 IP／ASIC", "codes": ["3443", "3661", "3035", "6643", "3529", "6533", "5274"]},
    {"name": "ABF 載板", "codes": ["3037", "8046", "3189"]},
    {"name": "高階 PCB／銅箔基板", "codes": ["2368", "2383", "6274", "3044", "2313", "6213"]},
    {"name": "記憶體", "codes": ["2344", "2408", "2337", "8299", "3260", "4967", "3006"]},
    {"name": "矽光子／CPO", "codes": ["3363", "4979", "3450", "3081", "6442", "2455", "4977"]},
    {"name": "重電／電網", "codes": ["1503", "1519", "1513", "1514", "1504", "1609"]},
    {"name": "電源／BBU", "codes": ["2308", "2301", "6412", "3015", "6781"]},
    {"name": "被動元件", "codes": ["2327", "2492", "3026", "6173", "2375"]},
    {"name": "機器人", "codes": ["2049", "1590", "4583", "2359", "8374", "1597"]},
    {"name": "低軌衛星", "codes": ["3491", "2314", "6285"]},
    {"name": "軍工／無人機", "codes": ["2634", "8033", "5222"]},
    {"name": "半導體 IC 設計", "codes": ["2454", "3034", "2379", "6415", "3035", "4966", "5269"]},
    {"name": "半導體設備", "codes": ["2404", "6196", "3680", "5536", "6139", "3131", "3583"]},
    {"name": "網通設備", "codes": ["2345", "5388", "3596", "6285", "2332", "3380", "4906"]},
    {"name": "面板", "codes": ["2409", "3481", "6116", "8069"]},
    {"name": "綠能（太陽能／風電）", "codes": ["3576", "6443", "6244", "6806", "9958"]},
    {"name": "汽車／電動車", "codes": ["2201", "2207", "1536", "1522", "2231", "3665"]},
]
HIST_DAYS = 20            # 族群輪動的歷史軌跡：最近幾個交易日


def _theme_name(name):
    name = str(name or "").strip()
    if not 1 <= len(name) <= 20 or any(ord(c) < 32 for c in name):
        raise ValueError("族群名稱請填 1～20 個字")
    return name


def normalize_themes(items):
    if not isinstance(items, list) or len(items) > MAX_THEMES:
        raise ValueError("概念族群最多 %d 個" % MAX_THEMES)
    out, seen = [], set()
    for it in items:
        if not isinstance(it, dict):
            raise ValueError("族群格式不正確")
        name = _theme_name(it.get("name"))
        if name in seen:
            raise ValueError("族群名稱重複：%s" % name)
        seen.add(name)
        raw = it.get("codes")
        if isinstance(raw, str):
            raw = re.split(r"[,，、;；\n]+", raw)
        if not isinstance(raw, list):
            raise ValueError("「%s」的代號格式不正確" % name)
        codes = []
        for item in raw:
            # 「3661 世芯-KY」：第一段是代號、後面是名稱；「2330 2317 2454」（全部都是代號）則每段都算
            toks = str(item).split()
            if not toks:
                continue
            is_code = lambda t: bool(STOCK_RE.match(t.upper()) or ETF_RE.match(t.upper()))
            for c in (toks if all(is_code(t) for t in toks) else toks[:1]):
                c = c.strip().upper()
                if not is_code(c):
                    raise ValueError("「%s」有無效的代號：%s（代號要寫在名稱前面）" % (name, c[:10]))
                if c not in codes:
                    codes.append(c)
        if not 2 <= len(codes) <= MAX_THEME_CODES:
            raise ValueError("「%s」請放 2～%d 檔" % (name, MAX_THEME_CODES))
        out.append({"name": name, "codes": codes})
    return out


def load_themes():
    """回傳 (族群清單, 是否為使用者自訂)。檔案壞掉時丟錯，不默默改用預設以免覆蓋使用者資料。"""
    try:
        with open(data_path("themes.json"), "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except FileNotFoundError:
        return [dict(t, codes=list(t["codes"])) for t in DEFAULT_THEMES], False
    except (OSError, ValueError):
        raise ValueError("themes.json 格式損壞，請先修復或更名；原檔未覆寫") from None
    return normalize_themes(data.get("themes") if isinstance(data, dict) else data), True


def save_themes(items):
    themes = normalize_themes(items)
    _write_json("themes.json", {"themes": themes})
    return themes


def _write_json(name, obj):
    path = data_path(name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _read_json(name, default):
    try:
        with open(data_path(name), "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        raise ValueError("%s 格式損壞，請先修復或更名；原檔未覆寫" % name) from None


# ==========================================================================
# 解析：證交所／櫃買的回應格式會改版，所以依欄位名稱找，不寫死欄位位置
# ==========================================================================
def _num(x):
    v = T.to_float(re.sub(r"<[^>]*>", "", str(x)) if isinstance(x, str) else x)
    return v if v is not None and math.isfinite(v) else None


def _text(x):
    return re.sub(r"<[^>]*>", "", str(x if x is not None else "")).strip()


def _tables(j):
    """列出回應中所有 (欄位名稱, 資料列)。支援 tables[]、fieldsN/dataN、fields/data、aaData。"""
    out = []
    if not isinstance(j, dict):
        return out
    for t in j.get("tables") or []:
        if isinstance(t, dict) and isinstance(t.get("fields"), list) and isinstance(t.get("data"), list):
            out.append(([_text(f) for f in t["fields"]], t["data"]))
    for k in list(j.keys()):
        m = re.fullmatch(r"fields(\d*)", k)
        if m and isinstance(j.get(k), list) and isinstance(j.get("data" + m.group(1)), list):
            out.append(([_text(f) for f in j[k]], j["data" + m.group(1)]))
    if isinstance(j.get("aaData"), list):
        out.append((None, j["aaData"]))
    return out


def _find(fields, *names, exclude=()):
    """回傳第一個「包含所有 names、不含 exclude」的欄位位置。"""
    for i, f in enumerate(fields):
        if all(n in f for n in names) and not any(x in f for x in exclude):
            return i
    return None


def _response_date(j):
    """回應自己標示的日期（YYYY-MM-DD）；沒有就回 None。"""
    cands = [j.get("date"), j.get("reportDate")]
    for t in j.get("tables") or []:
        if isinstance(t, dict):
            cands.append(t.get("date"))
    for c in cands:
        c = str(c or "").strip()
        if re.fullmatch(r"\d{8}", c):
            return "%s-%s-%s" % (c[:4], c[4:6], c[6:])
        if re.fullmatch(r"\d{4}[/-]\d{1,2}[/-]\d{1,2}", c):
            y, m, d = re.split(r"[/-]", c)
            return "%04d-%02d-%02d" % (int(y), int(m), int(d))
        iso = T.roc_to_iso(c) if re.fullmatch(r"\d{2,3}/\d{1,2}/\d{1,2}", c) else None
        if iso:
            return iso
    return None


class FormatError(ValueError):
    """回應看得懂是 JSON，但找不到需要的欄位。"""


def parse_twse_quotes(j):
    """MI_INDEX → {代號: [開, 高, 低, 收, 量(張), 金額(元), 筆數, 漲跌]}；休市回 {}。"""
    if not isinstance(j, dict):
        raise FormatError("不是 JSON 物件")
    stat = str(j.get("stat", ""))
    if stat and stat.upper() != "OK":
        if "沒有符合" in stat or "查詢日期" in stat or "無資料" in stat:
            return {}
        raise FormatError("stat=" + stat[:40])
    for fields, data in _tables(j):
        if not fields:
            continue
        ic, iclose = _find(fields, "證券代號"), _find(fields, "收盤價")
        if ic is None or iclose is None:
            continue
        idx = {"name": _find(fields, "證券名稱"), "vol": _find(fields, "成交股數"), "trades": _find(fields, "成交筆數"),
               "amount": _find(fields, "成交金額"), "open": _find(fields, "開盤價"), "high": _find(fields, "最高價"),
               "low": _find(fields, "最低價"), "sign": _find(fields, "漲跌(+/-)"), "diff": _find(fields, "漲跌價差")}
        rows = {}
        for r in data:
            if not isinstance(r, list) or len(r) <= max(ic, iclose):
                continue
            code = _text(r[ic]).upper()
            get = lambda k: r[idx[k]] if idx[k] is not None and idx[k] < len(r) else None
            chg = None
            sign, diff = _text(get("sign")), _num(get("diff"))
            if diff is not None and sign in ("+", "-", ""):
                chg = -diff if sign == "-" else diff if sign == "+" else (0.0 if diff == 0 else None)
            vol = _num(get("vol"))
            rows[code] = [_num(get("open")), _num(get("high")), _num(get("low")), _num(r[iclose]),
                          None if vol is None else vol / 1000.0, _num(get("amount")), _num(get("trades")), chg,
                          _text(get("name"))]
        return rows
    raise FormatError("找不到「證券代號／收盤價」欄位")


def parse_tpex_quotes(j):
    """櫃買每日收盤行情（新版 tables 或舊版 aaData）→ 與上市相同格式。"""
    if not isinstance(j, dict):
        raise FormatError("不是 JSON 物件")
    for fields, data in _tables(j):
        if fields is None:            # 舊版 aaData：代號,名稱,收盤,漲跌,開盤,最高,最低,均價,成交股數,成交金額,成交筆數,...
            pos = {"code": 0, "name": 1, "close": 2, "chg": 3, "open": 4, "high": 5, "low": 6, "vol": 8, "amount": 9, "trades": 10}
        else:
            pos = {"code": _find(fields, "代號"), "name": _find(fields, "名稱"), "close": _find(fields, "收盤"),
                   "chg": _find(fields, "漲跌", exclude=("漲停", "跌停")), "open": _find(fields, "開盤"),
                   "high": _find(fields, "最高"), "low": _find(fields, "最低"), "vol": _find(fields, "成交股數"),
                   "amount": _find(fields, "成交金額"), "trades": _find(fields, "成交筆數")}
            if pos["code"] is None or pos["close"] is None:
                continue
        rows = {}
        for r in data:
            if not isinstance(r, list) or len(r) <= max(v for v in pos.values() if v is not None):
                continue
            get = lambda k: r[pos[k]] if pos[k] is not None else None
            code = _text(get("code")).upper()
            if not code:
                continue
            vol = _num(get("vol"))
            rows[code] = [_num(get("open")), _num(get("high")), _num(get("low")), _num(get("close")),
                          None if vol is None else vol / 1000.0, _num(get("amount")), _num(get("trades")), _num(get("chg")),
                          _text(get("name"))]
        return rows
    if j.get("aaData") == [] or any(isinstance(t, dict) and t.get("data") == [] for t in j.get("tables") or []) or \
            str(j.get("iTotalRecords", "")) == "0":
        return {}
    raise FormatError("找不到「代號／收盤」欄位")


def parse_tpex_insti(j):
    """櫃買三大法人 → {代號: [外資, 投信, 自營商, 合計]}（張）。"""
    if not isinstance(j, dict):
        raise FormatError("不是 JSON 物件")
    for fields, data in _tables(j):
        if fields is None:
            # 舊版：代號,名稱, 外資(不含外資自營商)買/賣/超, 外資自營商買/賣/超, 外資合計買/賣/超, 投信買/賣/超,
            #       自營商(自行)買/賣/超, 自營商(避險)買/賣/超, 自營商合計買/賣/超, 三大法人合計
            pos = {"code": 0, "foreign": 10, "trust": 13, "dealer": 22, "total": -1}
        else:
            pos = {"code": _find(fields, "代號"), "total": _find(fields, "三大法人"),
                   "trust": _find(fields, "投信", "買賣超"),
                   "foreign": _find(fields, "外資", "買賣超", exclude=("不含", "自營商")),
                   "dealer": _find(fields, "自營商", "買賣超", exclude=("外資", "自行", "避險"))}
            if pos["code"] is None or pos["total"] is None:
                continue
        rows = {}
        for r in data:
            if not isinstance(r, list) or len(r) < 3:
                continue
            get = lambda k: (r[pos[k]] if pos[k] is not None and -len(r) <= pos[k] < len(r) else None)
            code = _text(get("code")).upper()
            vals = [_num(get(k)) for k in ("foreign", "trust", "dealer", "total")]
            rows[code] = [None if v is None else v / 1000.0 for v in vals]
        return rows
    if j.get("aaData") == [] or any(isinstance(t, dict) and t.get("data") == [] for t in j.get("tables") or []):
        return {}
    raise FormatError("找不到「代號／三大法人」欄位")


# ==========================================================================
# 下載：逐日快取、節流、休市記錄、改版時改用備用網址並記錄
# ==========================================================================
_throttle_lock = threading.Lock()
_last_hit = {}


def _wait(url):
    host = urllib.parse.urlsplit(url).netloc
    gap = INTERVAL.get(host, 0)
    if not gap:
        return
    with _throttle_lock:
        now = time.monotonic()
        wait = _last_hit.get(host, 0) + gap - now
        _last_hit[host] = max(now, _last_hit.get(host, 0) + gap)
    if wait > 0:
        time.sleep(wait)


def debug_log(source, url, text, reason):
    """把看不懂的回應開頭記下來（網址不含 Token）。檔案超過 200KB 就從頭開始。"""
    try:
        path = data_path("market_debug.log")
        mode = "w" if os.path.exists(path) and os.path.getsize(path) > 200_000 else "a"
        with open(path, mode, encoding="utf-8") as f:
            f.write("=== %s  %s  %s\n%s\n%s\n\n" % (_dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), source,
                                                 reason, url, (text or "")[:1500]))
    except OSError:
        pass


OFFLINE = "offline"


def _get(url, params, source, parser):
    """下載並解析；回傳 (解析結果, None) 或 (None, 原因)。這次已經連不上的網站直接略過，不再等待。"""
    host = urllib.parse.urlsplit(url).netloc
    st = TC.state() or {}
    if host in st.get("offline_hosts", ()):
        return None, OFFLINE
    _wait(url)
    text = T.http_get_json(url, params, raw_text=True, timeout=25)
    full = url + "?" + urllib.parse.urlencode(params)
    if text is None:
        reason = (st.get("errors") or {}).get(host, "連線失敗")
        debug_log(source, full, "", reason)
        # 連線層失敗時 http_get_json 已經針對整個網站提示過原因，這裡不再重複
        return None, OFFLINE if host in st.get("offline_hosts", ()) else reason
    try:
        j = json.loads(text)
    except ValueError:
        debug_log(source, full, text, "不是 JSON")
        return None, "回應不是 JSON（可能暫時被限制查詢頻率，請稍後再試）"
    try:
        return (j, parser(j)), None
    except FormatError as e:
        debug_log(source, full, text, str(e))
        return None, "格式無法辨識"


def diagnose(token="", yahoo=False):
    """「連線檢查」：各資料來源各打一次，回報狀態與原因（不含 Token），方便判斷是網路、憑證還是格式問題。"""
    import platform
    import ssl as _ssl
    d = TC.today() - _dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= _dt.timedelta(days=1)
    targets = [
        ("證交所 上市行情", TWSE_ALL, {"date": d.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"}, parse_twse_quotes),
        ("證交所 三大法人", T.TWSE_T86, {"date": d.strftime("%Y%m%d"), "selectType": "ALL", "response": "json"}, _parse_t86),
        ("櫃買 上櫃行情（新版網址）", TPEX_DAY[0], {"date": d.strftime("%Y/%m/%d"), "id": "", "response": "json"}, parse_tpex_quotes),
        ("櫃買 上櫃行情（舊版網址）", TPEX_DAY[1], {"l": "zh-tw", "o": "json", "d": _roc(d)}, parse_tpex_quotes),
        ("櫃買 三大法人（新版網址）", TPEX_INSTI[0], {"type": "Daily", "sect": "EW", "date": d.strftime("%Y/%m/%d"), "response": "json"}, parse_tpex_insti),
        ("櫃買 三大法人（舊版網址）", TPEX_INSTI[1], {"l": "zh-tw", "se": "EW", "t": "D", "d": _roc(d), "o": "json"}, parse_tpex_insti),
        ("FinMind", T.FINMIND, {"dataset": "TaiwanStockPrice", "data_id": "2330", "start_date": d.isoformat(), "end_date": d.isoformat()}, None),
    ]
    if yahoo:                                             # 使用者勾選了 Yahoo 備援才檢查
        start = int(_dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc).timestamp()) - 7 * 86400
        targets.append(("Yahoo 財經 日經 225（選用）", T.DEFAULT_ENDPOINTS["yahoo"] + "%5EN225",
                        {"period1": start, "period2": start + 9 * 86400, "interval": "1d"}, "yahoo"))
    out = []
    for label, url, params, parser in targets:
        item = {"source": label, "host": urllib.parse.urlsplit(url).netloc, "date": d.isoformat()}
        headers = {"User-Agent": T.UA, "Accept": "application/json, text/plain, */*"}
        if token and "finmind" in url:
            headers["Authorization"] = "Bearer " + token
        t0 = time.monotonic()
        try:
            _wait(url)
            req = T.urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers=headers)
            with T.urllib.request.urlopen(req, timeout=12, context=T._SSL_CTX) as r:
                body = r.read().decode("utf-8", errors="replace")
                item["http"] = r.status
            item["bytes"] = len(body)
            try:
                j = json.loads(body)
            except ValueError:
                item.update(ok=False, result="回應不是 JSON", head=re.sub(r"\s+", " ", body[:160]))
            else:
                if parser is None:
                    good = isinstance(j, dict) and j.get("status") in (200, "200")
                    item.update(ok=good, result="正常" if good else "回應異常：%s" % str(j.get("msg") or j.get("status"))[:80])
                elif parser == "yahoo":
                    import twmacro
                    rows = twmacro.parse_yahoo_chart(j, "1900-01-01", "2999-12-31")
                    err = ((j.get("chart") or {}).get("error") or {}) if isinstance(j, dict) else {}
                    item.update(ok=rows is not None, result=("正常（%d 筆）" % len(rows)) if rows else
                                "連得上，但這段期間沒有收盤資料" if rows == [] else
                                ("回應異常：%s" % str(err.get("description") or err.get("code") or "格式無法辨識")[:80]))
                else:
                    try:
                        rows = parser(j)
                        n = len(rows or {}) if isinstance(rows, dict) and "rows" not in rows else len((rows or {}).get("rows", {}))
                        item.update(ok=True, result="正常（%d 筆）" % n if n else "連得上，但這天沒有資料（休市或尚未公布）")
                    except FormatError as e:
                        item.update(ok=False, result="格式無法辨識：%s" % e, head=re.sub(r"\s+", " ", body[:160]))
        except T.urllib.error.HTTPError as e:
            item.update(ok=False, http=e.code, result=T.describe_error(e))
        except Exception as e:                                        # noqa: BLE001
            item.update(ok=False, result=T.describe_error(e))
        item["ms"] = int((time.monotonic() - t0) * 1000)
        out.append(item)
    proxies = sorted(k for k in T.urllib.request.getproxies() if k in ("http", "https"))     # 只列有沒有設定，不列位址
    return {"checks": out, "python": platform.python_version(), "openssl": _ssl.OPENSSL_VERSION,
            "os": platform.platform(terse=True), "proxy": proxies,
            "x509_strict_off": bool(hasattr(_ssl, "VERIFY_X509_STRICT") and not (T._SSL_CTX.verify_flags & _ssl.VERIFY_X509_STRICT))}


def _roc(day):
    return "%d/%02d/%02d" % (day.year - 1911, day.month, day.day)


def _day_record(key, day, fetch, allow_network):
    """一天一筆：{"closed": true} 或 {"rows": {...}}。過去日子存了就不再抓；今天的資料 15 分鐘後可再確認。"""
    cached = TC.read(key).get("")
    fresh_for = None if day < TC.today() else TC.TTL
    if cached and (fresh_for is None or time.time() - cached[1] < fresh_for):
        TC.count("cache_hits")
        return cached[0]
    if not allow_network:
        return cached[0] if cached else None
    TC.count("network_requests")
    rec = fetch()
    if rec is None:
        if cached:
            return cached[0]
        return None
    TC.write(key, {"": rec}, kind="market-day")
    TC.count("downloaded_days")
    return rec


def _twse_quotes(day, allow_network):
    key = TC.key_for("market-twse-quotes-v1", TWSE_ALL, day.isoformat())
    def fetch():
        got, why = _get(TWSE_ALL, {"date": day.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"},
                        "上市行情", parse_twse_quotes)
        if got is None:
            if why != OFFLINE:
                TC.warn("上市行情：%s，缺漏的日子下次重試。" % why)
            return None
        j, rows = got
        rdate = _response_date(j)
        if not rows or (rdate and rdate != day.isoformat()):
            return {"closed": True}
        return {"rows": rows}
    return _day_record(key, day, fetch, allow_network)


def _parse_t86(j):
    if not isinstance(j, dict):
        raise FormatError("不是 JSON 物件")
    if str(j.get("stat", "")).upper() != "OK":
        return None                                   # 還沒公布（當天傍晚前）或休市
    if not any(f and _find(f, "證券代號") is not None for f, _ in _tables(j)) and not isinstance(j.get("data"), list):
        raise FormatError("找不到「證券代號」欄位")
    return T._compact_t86(j)


def _twse_chips(day, allow_network):
    """上市三大法人。與個股分析共用同一個快取鍵（精簡格式 {代號: [外資, 投信, 自營商]}）。"""
    params = {"date": day.strftime("%Y%m%d"), "selectType": "ALL", "response": "json"}
    key = TC.key_for("twse-v2", T.TWSE_T86, params)
    def fetch():
        got, why = _get(T.TWSE_T86, params, "上市法人", _parse_t86)
        if got is None:
            if why != OFFLINE:
                TC.warn("上市法人：%s，缺漏的日子下次重試。" % why)
            return None
        return got[1]                                 # None＝尚未公布，不存
    rec = _day_record(key, day, fetch, allow_network)
    if not rec or rec.get("stat") != "OK":
        return None
    return {code: list(v) + [sum(v) if all(x is not None for x in v) else None] for code, v in (rec.get("rows") or {}).items()}


_tpex_pref = {"quotes": 0, "insti": 0}


def _tpex(kind, day, allow_network):
    urls, parser, label = ((TPEX_DAY, parse_tpex_quotes, "上櫃行情") if kind == "quotes"
                           else (TPEX_INSTI, parse_tpex_insti, "上櫃法人"))
    key = TC.key_for("market-tpex-%s-v1" % kind, day.isoformat())
    def fetch():
        tries = [(urls[0], ({"date": day.strftime("%Y/%m/%d"), "id": "", "response": "json"} if kind == "quotes"
                            else {"type": "Daily", "sect": "EW", "date": day.strftime("%Y/%m/%d"), "response": "json"})),
                 (urls[1], ({"l": "zh-tw", "o": "json", "d": _roc(day)} if kind == "quotes"
                            else {"l": "zh-tw", "se": "EW", "t": "D", "d": _roc(day), "o": "json"}))]
        why = None
        first = _tpex_pref[kind]
        for idx in (first, 1 - first):
            url, params = tries[idx]
            got, why = _get(url, params, label, parser)
            if got is not None:
                _tpex_pref[kind] = idx
                j, rows = got
                rdate = _response_date(j)
                if not rows or (rdate and rdate != day.isoformat()):
                    return {"closed": True}
                return {"rows": rows}
        if why != OFFLINE:
            TC.warn("%s：%s，缺漏的日子下次重試。" % (label, why))
        return None
    return _day_record(key, day, fetch, allow_network)


def _info(token, allow_network):
    """FinMind 全部股票基本資料 → {代號: {"name", "industry", "market"}}。"""
    key = TC.key_for("market-info-v1", T.FINMIND)
    cached = TC.read(key).get("")
    if cached and time.time() - cached[1] < 86400:
        return cached[0]
    if not allow_network:
        return cached[0] if cached else {}
    headers = {"Authorization": "Bearer " + token} if token else {}
    TC.count("network_requests")
    j = T.http_get_json(T.FINMIND, {"dataset": "TaiwanStockInfo"}, headers=headers)
    rows = j.get("data") if isinstance(j, dict) and j.get("status") in (200, "200") else None
    if not isinstance(rows, list) or not rows:
        TC.warn("產業別：FinMind 股票清單未取得，這次只能用概念族群。")
        return cached[0] if cached else {}
    generic = {"電子工業", "化學生技醫療", "Index", "大盤", ""}
    info = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        code = str(r.get("stock_id", "")).strip().upper()
        cat = str(r.get("industry_category") or "").strip()
        mkt = str(r.get("type") or "").lower()
        if not code or mkt not in ("twse", "tpex"):
            continue
        cur = info.setdefault(code, {"name": str(r.get("stock_name") or code), "industry": "", "market": mkt})
        if cat and (not cur["industry"] or (cur["industry"] in generic and cat not in generic)):
            cur["industry"] = cat
    TC.write(key, {"": info}, kind="market-info")
    return info


def _weekdays_back(n_max):
    d = TC.today()
    out = []
    while len(out) < n_max:
        if d.weekday() < 5:
            out.append(d)
        d -= _dt.timedelta(days=1)
    return out


def collect(trading_days=61, token="", allow_network=True, progress=None):
    """取得最近 trading_days 個交易日的上市櫃行情與最近 CHIP_DAYS 日法人。回傳 raw dict 或 None。"""
    budget = int(trading_days * 1.55) + 8               # 平日數上限（含連假）
    candidates = _weekdays_back(budget)
    total = [len(candidates) * 2 + CHIP_DAYS * 2]
    done = [0]
    lock = threading.Lock()

    def tick(label):
        with lock:
            done[0] += 1
            n, t = done[0], total[0]
        if progress:
            progress(n, t, label)

    def shrink(n):
        with lock:
            total[0] -= n

    def walk(fetch_one, label):
        days, seen = {}, 0
        for d in candidates:
            TC.report(detail="%s（已取得 %d/%d 個交易日）" % (d.isoformat(), len(days), trading_days))
            rec = fetch_one(d, allow_network)
            seen += 1
            tick(label)
            if rec and not rec.get("closed"):
                days[d.isoformat()] = rec["rows"]
                if len(days) >= trading_days:
                    break
        shrink(len(candidates) - seen)
        return days

    def twse():
        quotes = walk(_twse_quotes, "上市")
        chips = {}
        want = sorted(quotes, reverse=True)[:CHIP_DAYS]
        shrink(CHIP_DAYS - len(want))
        for ds in want:
            TC.report(detail="法人 %s" % ds)
            rec = _twse_chips(_dt.date.fromisoformat(ds), allow_network)
            tick("上市法人")
            if rec is not None:
                chips[ds] = rec
        return quotes, chips

    def tpex():
        quotes = walk(lambda d, a: _tpex("quotes", d, a), "上櫃")
        chips = {}
        want = sorted(quotes, reverse=True)[:CHIP_DAYS]
        shrink(CHIP_DAYS - len(want))
        for ds in want:
            TC.report(detail="法人 %s" % ds)
            rec = _tpex("insti", _dt.date.fromisoformat(ds), allow_network)
            tick("上櫃法人")
            if rec is not None and not rec.get("closed"):
                chips[ds] = rec["rows"]
        return quotes, chips

    TC.report("全市場行情", "同時讀取上市、上櫃與產業別")
    (tw_q, tw_c), (tp_q, tp_c), info = TC.parallel([("上市", twse), ("上櫃", tpex),
                                                    ("產業別", lambda: _info(token, allow_network))], max_workers=3)
    if not tw_q and not tp_q:
        return None
    return {"twse": tw_q, "tpex": tp_q, "twse_chips": tw_c, "tpex_chips": tp_c, "info": info}


# ==========================================================================
# 指標
# ==========================================================================
def _mean(v):
    return sum(v) / len(v) if v else None


def _pct(a, b):
    return (a / b - 1) * 100.0 if a is not None and b else None


def stock_metrics(code, market, dates, series, chips, info):
    """series：與 dates 對齊的 [開,高,低,收,量,金額,筆數,漲跌,名稱]（沒交易為 None）。"""
    last = series[-1]
    if not last or last[3] is None:
        return None
    valid = [(i, r) for i, r in enumerate(series) if r and r[3] is not None]
    closes = [r[3] for _, r in valid]
    vols = [r[4] or 0.0 for _, r in valid]
    amounts = [r[5] or 0.0 for _, r in valid]
    n = len(dates) - 1

    def back(k):
        """k 個交易日前的收盤；那天沒交易就再往前找最多 3 天。"""
        for j in range(n - k, max(-1, n - k - 4), -1):
            if 0 <= j and series[j] and series[j][3] is not None:
                return series[j][3]
        return None

    def ma(k, drop=0):
        c = closes[:len(closes) - drop] if drop else closes
        return _mean(c[-k:]) if len(c) >= k else None

    c = last[3]
    prev = back(1)
    chg = last[7]
    chg_pct = (chg / (c - chg) * 100.0) if chg is not None and c - chg > 0 else _pct(c, prev)
    ma5, ma10, ma20, ma60 = ma(5), ma(10), ma(20), ma(60)
    ma20_prev, ma20_5 = ma(20, 1), ma(20, 5)
    vavg = _mean(vols[-20:]) if len(vols) >= 10 else None
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(max(1, len(closes) - 20), len(closes))
            if closes[i - 1] > 0 and closes[i] > 0]
    vol20 = statistics.stdev(rets) * math.sqrt(252) * 100 if len(rets) >= 10 else None

    # 法人：從最新一天往回數連續買超／賣超
    chip_dates = sorted(chips, reverse=True)
    totals, trusts, foreigns = [], [], []
    for d in chip_dates:
        v = chips[d].get(code)
        totals.append(v[3] if v else None)
        trusts.append(v[1] if v else None)
        foreigns.append(v[0] if v else None)

    def streak(vals):
        s = 0
        sign = 0
        for v in vals:
            if v is None or v == 0:
                break
            cur = 1 if v > 0 else -1
            if sign and cur != sign:
                break
            sign = cur
            s += 1
        return s * sign

    net5 = sum(totals[:5]) if len(totals) >= 5 and all(v is not None for v in totals[:5]) else None
    inf = info.get(code) or {}
    return {
        "code": code, "name": inf.get("name") or last[8] or code, "market": market,
        "industry": inf.get("industry") or "", "kind": "etf" if ETF_RE.match(code) else "stock" if STOCK_RE.match(code) else "other",
        "close": T.r2(c), "chg": T.r2(chg if chg is not None else (c - prev if prev else None)), "chg_pct": T.r2(chg_pct),
        "open": T.r2(last[0]), "high": T.r2(last[1]), "low": T.r2(last[2]),
        "vol": T.r2(last[4], 1), "amount": last[5], "trades": last[6],
        "vratio": T.r2(last[4] / vavg) if vavg and last[4] is not None else None,
        "amount20": _mean(amounts[-20:]) if len(amounts) >= 10 else None,
        "r5": T.r2(_pct(c, back(5))), "r20": T.r2(_pct(c, back(20))), "r60": T.r2(_pct(c, back(60))),
        "ma5": T.r2(ma5), "ma10": T.r2(ma10), "ma20": T.r2(ma20), "ma60": T.r2(ma60),
        "above20": bool(ma20 and c > ma20), "ma20_up": bool(ma20 and ma20_5 and ma20 > ma20_5),
        "bull_align": bool(ma5 and ma10 and ma20 and ma5 > ma10 > ma20),
        "cross20": bool(ma20 and ma20_prev and prev is not None and c > ma20 and prev <= ma20_prev),
        "high20_break": len(closes) > 20 and c > max(closes[-21:-1]),
        "new_high60": len(closes) >= 60 and c >= max(closes[-60:]),
        "vol20": T.r2(vol20, 1),
        "chip_date": chip_dates[0] if chip_dates else None,
        "chip_total": T.r2(totals[0], 0) if totals and totals[0] is not None else None,
        "net5": T.r2(net5, 0), "streak": streak(totals), "trust_streak": streak(trusts), "foreign_streak": streak(foreigns),
        "limit_up": chg_pct is not None and chg_pct >= 9.5, "days": len(closes),
    }


def _rank(values):
    """百分位（0～1，同值取中位名次）。"""
    import bisect
    s = sorted(values)
    out = {}
    for v in set(values):
        lo, hi = bisect.bisect_left(s, v), bisect.bisect_right(s, v)
        out[v] = (lo + (hi - lo - 1) / 2) / (len(s) - 1) if len(s) > 1 else 0.5
    return out


def scan_scores(stocks, universe):
    """綜合強勢分（0～100）：動能 50（20 日報酬百分位 30＋5 日 20）、趨勢 25、量能 10、籌碼 15。"""
    r20 = _rank([s["r20"] for s in universe if s["r20"] is not None])
    r5 = _rank([s["r5"] for s in universe if s["r5"] is not None])
    for s in stocks:
        if s["r20"] is None or s["r5"] is None:
            s["scan_score"] = None
            continue
        pts = 30 * r20.get(s["r20"], _nearest(r20, s["r20"])) + 20 * r5.get(s["r5"], _nearest(r5, s["r5"]))
        pts += (15 if s["above20"] and s["ma20_up"] else 0) + (10 if s["bull_align"] else 0)
        if s["vratio"] is not None and (s["chg_pct"] or 0) > 0:
            pts += 10 * min(max(s["vratio"] - 1, 0), 1)
        cap = 85.0
        if s["net5"] is not None:
            cap = 100.0
            pts += 15 if s["net5"] > 0 else 0
        s["scan_score"] = T.r2(pts / cap * 100, 1)


def _nearest(ranks, v):
    if not ranks:
        return 0.5
    k = min(ranks, key=lambda x: abs(x - v))
    return ranks[k]


SCREENS = [
    ("strong", "綜合強勢", "綜合強勢分由高到低（動能、趨勢、量能、籌碼四項規則分）"),
    ("breakout", "放量突破", "今日上漲 ≥ 3%、量比 ≥ 2 倍，且收盤突破前 20 日最高收盤"),
    ("cross20", "站上月線", "今日收盤由下往上穿越 MA20（前一日收在 MA20 之下）"),
    ("high60", "創 60 日新高", "收盤創近 60 個交易日新高"),
    ("inst", "法人連買", "三大法人合計連續買超 ≥ 3 個交易日"),
    ("trust", "投信連買", "投信連續買超 ≥ 3 個交易日"),
    ("rebound", "跌深反彈", "近 20 日下跌 ≥ 15%，今日上漲 ≥ 3%"),
    ("leader", "強勢族群領頭", "「領漲」象限族群中，20 日報酬前 3 名的成員"),
]


def tags(s):
    t = []
    if s["limit_up"]:
        t.append("漲停")
    if s["streak"] >= 2:
        t.append("法人連買%d日" % s["streak"])
    elif s["streak"] <= -2:
        t.append("法人連賣%d日" % -s["streak"])
    if s["trust_streak"] >= 2:
        t.append("投信連買%d日" % s["trust_streak"])
    if s["new_high60"]:
        t.append("60日新高")
    elif s["high20_break"]:
        t.append("突破20日高")
    if s["cross20"]:
        t.append("站上月線")
    if s["vratio"] is not None and s["vratio"] >= 2:
        t.append("爆量")
    if s["bull_align"]:
        t.append("多頭排列")
    return t


def screens(stocks, sectors, limit=40):
    pick = {
        "strong": (lambda s: s["scan_score"] is not None, lambda s: -s["scan_score"]),
        "breakout": (lambda s: (s["chg_pct"] or 0) >= 3 and (s["vratio"] or 0) >= 2 and s["high20_break"], lambda s: -s["vratio"]),
        "cross20": (lambda s: s["cross20"], lambda s: -(s["amount"] or 0)),
        "high60": (lambda s: s["new_high60"], lambda s: -(s["r20"] or 0)),
        "inst": (lambda s: s["streak"] >= 3, lambda s: (-s["streak"], -(s["net5"] or 0))),
        "trust": (lambda s: s["trust_streak"] >= 3, lambda s: (-s["trust_streak"], -(s["net5"] or 0))),
        "rebound": (lambda s: (s["r20"] if s["r20"] is not None else 0) <= -15 and (s["chg_pct"] or 0) >= 3, lambda s: -(s["chg_pct"] or 0)),
    }
    out = {}
    for key, (cond, order) in pick.items():
        out[key] = [s["code"] for s in sorted((s for s in stocks if cond(s)), key=order)[:limit]]
    by = {s["code"]: s for s in stocks}
    lead = []
    for g in sectors:
        if g["quadrant"] != "領漲":
            continue
        mem = sorted((by[c] for c in g["members"] if c in by and by[c]["r20"] is not None), key=lambda s: -s["r20"])[:3]
        lead += [s["code"] for s in mem if s["code"] not in lead]
    out["leader"] = lead[:limit]
    return out


def quadrant(r5, r20):
    if r5 is None or r20 is None:
        return None
    return ("領漲" if r5 >= 0 else "轉弱") if r20 >= 0 else ("轉強" if r5 >= 0 else "落後")


def _back_pct(closes, j, k):
    """closes 與日期對齊（沒交易為 None）：第 j 天相對 k 個交易日前的漲跌（%）；那天沒交易就再往前找最多 3 天。"""
    c = closes[j] if 0 <= j < len(closes) else None
    if c is None:
        return None
    for jj in range(j - k, j - k - 4, -1):
        if 0 <= jj and closes[jj] is not None:
            return (c / closes[jj] - 1) * 100.0 if closes[jj] > 0 else None
    return None


def history_series(members, closes, ndates, days=HIST_DAYS):
    """最近 days 個交易日，每天成員的等權平均：當日漲跌、5 日、20 日報酬（算不出來為 None）。"""
    idx = range(max(1, ndates - days), ndates)

    def one(k):
        out = []
        for j in idx:
            vals = [v for v in (_back_pct(closes[c], j, k) for c in members if c in closes) if v is not None]
            out.append(T.r2(_mean(vals)) if vals else None)
        return out
    return {"day": one(1), "r5": one(5), "r20": one(20)}


def sector_table(groups, by, min_amount, closes=None, ndates=0):
    """groups：[(名稱, 類型, [代號])]。報酬取成員的等權平均（先用 20 日均成交值達門檻的成員）。
    有 closes 時另外附上最近 HIST_DAYS 個交易日的軌跡（熱力矩陣、排名變化、象限時間軸、動能加速度用）。"""
    out = []
    for name, kind, codes in groups:
        members = [by[c] for c in codes if c in by]
        liquid = [s for s in members if (s["amount20"] or 0) >= min_amount]
        use = liquid if len(liquid) >= MIN_MEMBERS else members
        if len(use) < MIN_MEMBERS:
            continue
        avg = lambda k: _mean([s[k] for s in use if s[k] is not None])
        vols = [s["vol20"] for s in use if s["vol20"] is not None]
        r5, r20, r60 = avg("r5"), avg("r20"), avg("r60")
        rep = sorted(use, key=lambda s: -(s["amount20"] or 0))[:5]
        today = [s["chg_pct"] for s in use if s["chg_pct"] is not None]
        hist = history_series([s["code"] for s in use], closes, ndates) if closes is not None and ndates > 1 else None
        out.append({"name": name, "kind": kind, "count": len(use), "total": len(codes),
                    "amount": round(sum(s["amount20"] or 0 for s in use)), "hist": hist,
                    "r5": T.r2(r5), "r20": T.r2(r20), "r60": T.r2(r60), "today": T.r2(_mean(today)),
                    "up_ratio": T.r2(sum(1 for v in today if v > 0) / len(today) * 100, 0) if today else None,
                    "vol": T.r2(statistics.median(vols), 1) if vols else None,
                    "quadrant": quadrant(r5, r20),
                    "leaders": [{"code": s["code"], "name": s["name"]} for s in rep],
                    "members": [s["code"] for s in sorted(members, key=lambda s: -(s["amount20"] or 0))],
                    "missing": [c for c in codes if c not in by]})
    return sorted(out, key=lambda g: -(g["r5"] if g["r5"] is not None else -1e9))


def analyse(raw, themes, min_amount=3e7):
    """raw（collect 的結果）→ 給畫面用的掃描結果。"""
    dates = sorted(set(raw["twse"]) | set(raw["tpex"]))
    if len(dates) < 6:
        raise ValueError("全市場資料只有 %d 個交易日，至少需要 6 天" % len(dates))
    stocks, closes = [], {}
    for market, quotes, chips in (("上市", raw["twse"], raw["twse_chips"]), ("上櫃", raw["tpex"], raw["tpex_chips"])):
        codes = set()
        for d in dates[-3:]:
            codes |= set((quotes.get(d) or {}).keys())
        for code in codes:
            if not (STOCK_RE.match(code) or ETF_RE.match(code)):
                continue
            series = [(quotes.get(d) or {}).get(code) for d in dates]
            m = stock_metrics(code, market, dates, series, chips, raw["info"])
            if m:
                stocks.append(m)
                closes[code] = [r[3] if r else None for r in series]
    by = {s["code"]: s for s in stocks}
    common = [s for s in stocks if s["kind"] == "stock"]
    universe = [s for s in common if (s["amount20"] or 0) >= min_amount]
    scan_scores(common, universe or common)
    for s in stocks:
        s["tags"] = tags(s)
        if s["kind"] != "stock":
            s["scan_score"] = None
    industries = {}
    for s in common:
        if s["industry"]:
            industries.setdefault(s["industry"], []).append(s["code"])
    groups = [(k, "產業", v) for k, v in sorted(industries.items())] + [(t["name"], "概念", t["codes"]) for t in themes]
    sectors = sector_table(groups, by, min_amount, closes, len(dates))
    market_hist = history_series([s["code"] for s in (universe or common)], closes, len(dates))
    for g in sectors:
        for c in g["members"]:
            by[c].setdefault("groups", []).append(g["name"])
    liquid = {s["code"] for s in universe}
    lists = screens([s for s in common if s["code"] in liquid or not liquid], sectors)
    for s in stocks:                      # 只留下畫面用得到的欄位，傳給瀏覽器的資料小一點
        for k in ("open", "ma5", "ma10", "ma60", "trades", "days"):
            s.pop(k, None)
        if s["amount20"] is not None:
            s["amount20"] = round(s["amount20"])
    latest = dates[-1]
    tw_latest = max(raw["twse"]) if raw["twse"] else None
    tp_latest = max(raw["tpex"]) if raw["tpex"] else None
    return {
        "latest_date": latest, "dates": [dates[0], latest], "trading_days": len(dates),
        "generated": _dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "counts": {"上市": sum(1 for s in stocks if s["market"] == "上市"), "上櫃": sum(1 for s in stocks if s["market"] == "上櫃"),
                   "stock": len(common), "etf": sum(1 for s in stocks if s["kind"] == "etf"), "universe": len(universe)},
        "market_dates": {"上市": tw_latest, "上櫃": tp_latest},
        "chip_dates": {"上市": max(raw["twse_chips"]) if raw["twse_chips"] else None,
                       "上櫃": max(raw["tpex_chips"]) if raw["tpex_chips"] else None},
        "has_industry": bool(industries), "min_amount": min_amount,
        "stocks": sorted(stocks, key=lambda s: s["code"]), "screens": lists,
        "screen_defs": [{"key": k, "label": l, "rule": r} for k, l, r in SCREENS],
        "sectors": sectors,
        "sector_dates": dates[max(1, len(dates) - HIST_DAYS):], "market_hist": market_hist,
    }


# ==========================================================================
# 警示與模擬持倉（存在程式資料夾的 JSON，不上傳）
# ==========================================================================
def _code(c):
    c = str(c or "").strip().upper()
    if not re.fullmatch(r"[0-9A-Z]{2,10}", c):
        raise ValueError("股票代號格式不正確")
    return c


def _price(v, label, allow_none=True):
    if v in (None, ""):
        if allow_none:
            return None
        raise ValueError("%s請填數字" % label)
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError("%s請填數字" % label) from None
    if not math.isfinite(f) or f <= 0 or f > 1e6:
        raise ValueError("%s超出範圍" % label)
    return round(f, 4)


def load_alerts():
    data = _read_json("alerts.json", {"alerts": []})
    return [a for a in (data.get("alerts") if isinstance(data, dict) else []) if isinstance(a, dict) and a.get("code")]


def save_alert(code, above=None, below=None, pct=None, note=""):
    code = _code(code)
    above, below = _price(above, "上限價"), _price(below, "下限價")
    pct = None if pct in (None, "") else _price(pct, "漲跌幅門檻")
    if pct is not None and pct > 20:
        raise ValueError("漲跌幅門檻請填 0～20")
    if above is None and below is None and pct is None:
        raise ValueError("請至少設定上限價、下限價或漲跌幅其中一項")
    if above is not None and below is not None and below >= above:
        raise ValueError("下限價要低於上限價")
    note = str(note or "")[:40]
    alerts = [a for a in load_alerts() if a["code"] != code]
    if len(alerts) >= 100:
        raise ValueError("警示最多 100 檔")
    alerts.append({"code": code, "above": above, "below": below, "pct": pct, "note": note,
                   "created": TC.today().isoformat(), "ack": None})
    _write_json("alerts.json", {"alerts": alerts})
    return alerts


def delete_alert(code):
    code = _code(code)
    alerts = load_alerts()
    if not any(a["code"] == code for a in alerts):
        raise ValueError("找不到這檔警示")
    alerts = [a for a in alerts if a["code"] != code]
    _write_json("alerts.json", {"alerts": alerts})
    return alerts


def ack_alerts(date):
    alerts = load_alerts()
    for a in alerts:
        a["ack"] = date
    _write_json("alerts.json", {"alerts": alerts})
    return alerts


def evaluate_alerts(alerts, quote):
    """quote(code) → {"date","close","high","low","chg_pct","name"} 或 None。"""
    out = []
    for a in alerts:
        q = quote(a["code"])
        hits = []
        if q:
            hi = q.get("high") if q.get("high") is not None else q.get("close")
            lo = q.get("low") if q.get("low") is not None else q.get("close")
            if a.get("above") is not None and hi is not None and hi >= a["above"]:
                hits.append("最高 %s 觸及上限 %s" % (_fmt(hi), _fmt(a["above"])))
            if a.get("below") is not None and lo is not None and lo <= a["below"]:
                hits.append("最低 %s 觸及下限 %s" % (_fmt(lo), _fmt(a["below"])))
            if a.get("pct") is not None and q.get("chg_pct") is not None and abs(q["chg_pct"]) >= a["pct"]:
                hits.append("漲跌 %+.2f%% 超過 ±%s%%" % (q["chg_pct"], _fmt(a["pct"])))
        out.append(dict(a, quote=q, hits=hits, triggered=bool(hits),
                        new=bool(hits) and bool(q) and a.get("ack") != q.get("date")))
    return out


def _fmt(v):
    return ("%.2f" % v).rstrip("0").rstrip(".") if isinstance(v, (int, float)) else str(v)


FEE, TAX_STOCK, TAX_ETF = 0.1425, 0.3, 0.1


def _tax(code):
    return TAX_ETF if ETF_RE.match(code) else TAX_STOCK


def load_portfolio():
    data = _read_json("portfolio.json", {"open": [], "closed": []})
    if not isinstance(data, dict):
        data = {}
    return {"open": [p for p in data.get("open", []) if isinstance(p, dict)],
            "closed": [p for p in data.get("closed", []) if isinstance(p, dict)]}


def _lots(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError("張數請填數字") from None
    if not math.isfinite(f) or f <= 0 or f > 10000 or round(f * 1000) != f * 1000:
        raise ValueError("張數請填 0.001～10000（零股以 0.001 張為單位）")
    return f


def _date(v):
    v = str(v or "").strip() or TC.today().isoformat()
    try:
        d = _dt.date.fromisoformat(v)
    except ValueError:
        raise ValueError("日期格式請用 YYYY-MM-DD") from None
    if d > TC.today():
        raise ValueError("日期不可晚於今天")
    return d.isoformat()


def paper_buy(code, price, lots, date="", name=""):
    code = _code(code)
    pf = load_portfolio()
    if len(pf["open"]) >= 200:
        raise ValueError("模擬持倉最多 200 筆")
    pos = {"id": "%s-%d" % (code, int(time.time() * 1000) % 10**10), "code": code, "name": str(name or code)[:30],
           "date": _date(date), "price": _price(price, "買進價", False), "lots": _lots(lots),
           "fee": FEE, "tax": _tax(code)}
    pf["open"].append(pos)
    _write_json("portfolio.json", pf)
    return pf


def paper_sell(pos_id, price, date=""):
    pf = load_portfolio()
    pos = next((p for p in pf["open"] if p.get("id") == pos_id), None)
    if not pos:
        raise ValueError("找不到這筆模擬持倉")
    price = _price(price, "賣出價", False)
    date = _date(date)
    if date < pos["date"]:
        raise ValueError("賣出日期不可早於買進日期")
    pf["open"] = [p for p in pf["open"] if p is not pos]
    closed = dict(pos, exit_date=date, exit_price=price)
    closed.update(pnl(pos, price))
    pf["closed"].insert(0, closed)
    pf["closed"] = pf["closed"][:500]
    _write_json("portfolio.json", pf)
    return pf


def paper_delete(pos_id, which="open"):
    pf = load_portfolio()
    if which not in ("open", "closed"):
        raise ValueError("參數不正確")
    before = len(pf[which])
    pf[which] = [p for p in pf[which] if p.get("id") != pos_id]
    if len(pf[which]) == before:
        raise ValueError("找不到這筆紀錄")
    _write_json("portfolio.json", pf)
    return pf


def pnl(pos, price):
    """買進成本＝價×股×(1＋手續費)；賣出淨額＝價×股×(1−手續費−交易稅)。"""
    shares = pos["lots"] * 1000
    cost = pos["price"] * shares * (1 + pos["fee"] / 100)
    value = price * shares * (1 - (pos["fee"] + pos["tax"]) / 100)
    return {"cost": round(cost), "value": round(value), "profit": round(value - cost),
            "return_pct": T.r2((value / cost - 1) * 100) if cost else None}


def portfolio_view(pf, quote):
    rows, cost, value = [], 0, 0
    for p in pf["open"]:
        q = quote(p["code"])
        row = dict(p, quote=q)
        if q and q.get("close") is not None:
            row.update(pnl(p, q["close"]))
            row["days"] = (_dt.date.fromisoformat(q["date"]) - _dt.date.fromisoformat(p["date"])).days
            cost += row["cost"]; value += row["value"]
        rows.append(row)
    realized = sum(p.get("profit", 0) for p in pf["closed"])
    priced = [r for r in rows if "profit" in r]
    return {"open": rows, "closed": pf["closed"],
            "summary": {"positions": len(rows), "priced": len(priced), "cost": cost, "value": value,
                        "unrealized": value - cost, "unrealized_pct": T.r2((value / cost - 1) * 100) if cost else None,
                        "realized": realized}}


# ==========================================================================
# 示範資料（--demo 與測試用）：約 170 檔合成股票，不是真實行情
# ==========================================================================
DEMO_INDUSTRIES = ["半導體業", "電腦及週邊設備業", "電子零組件業", "光電業", "通信網路業", "航運業", "金融保險業", "鋼鐵工業", "生技醫療業", "電機機械"]


def demo_raw(trading_days=61, seed=11):
    rnd = random.Random(seed)
    codes = sorted({c for t in DEFAULT_THEMES for c in t["codes"]})
    extra = ["%04d" % n for n in range(1101, 1101 + 100 * 2, 2)]
    codes = sorted(set(codes) | set(extra[:90]))
    etfs = ["0050", "0056", "00878", "00919", "00929", "006208", "00679B", "00632R", "00631L", "00940"]
    dates, d = [], TC.today()
    while len(dates) < trading_days:
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d -= _dt.timedelta(days=1)
    dates.reverse()
    twse, tpex, tw_c, tp_c = {d: {} for d in dates}, {d: {} for d in dates}, {}, {}
    info = {}
    # 族群輪動的示範效果：每個產業／概念族群有自己的週期波動，讓象限隨時間轉換
    theme_of = {}
    for t in DEFAULT_THEMES:
        for c in t["codes"]:
            theme_of.setdefault(c, t["name"])

    def wave(key):
        r0 = random.Random(zlib.crc32(key.encode()) ^ seed)
        amp, period, phase = r0.uniform(0.002, 0.007), r0.uniform(26, 48), r0.uniform(0, 6.283)
        return lambda t: amp * math.sin(6.283 * t / period + phase)
    for i, code in enumerate(codes + etfs):
        r = random.Random(zlib.crc32(code.encode()) ^ seed)
        market = "tpex" if (code[0] in "345689" and i % 3 == 0) else "twse"
        info[code] = {"name": ("ETF" if code.startswith("00") else "示範") + code, "market": market,
                      "industry": "" if code.startswith("00") else DEMO_INDUSTRIES[zlib.crc32(code.encode()) % len(DEMO_INDUSTRIES)]}
        px, drift = 20 + r.random() * 400, r.gauss(0.0008, 0.002)
        base = r.choice([300, 800, 2000, 6000, 20000])
        prev = px
        w1 = wave(info[code]["industry"] or "etf")
        w2 = wave(theme_of[code]) if code in theme_of else (lambda t: 0.0)
        for t, d in enumerate(dates):
            ret = r.gauss(drift, 0.022) + w1(t) + w2(t)
            px = max(1.0, px * (1 + ret))
            hi, lo = px * (1 + abs(r.gauss(0, 0.01))), px * (1 - abs(r.gauss(0, 0.01)))
            vol = base * (0.5 + r.random() * 1.2) * (2.5 if r.random() < 0.05 else 1)
            row = [round(prev * (1 + r.gauss(0, 0.004)), 2), round(hi, 2), round(lo, 2), round(px, 2),
                   round(vol, 1), round(vol * 1000 * px), int(vol * 2), round(px - prev, 2), info[code]["name"]]
            (tpex if market == "tpex" else twse)[d][code] = row
            prev = px
        for d in dates[-CHIP_DAYS:]:
            bias = 1 if drift > 0.0015 else -1 if drift < 0 else 0
            fo, tr, de = [round(r.gauss(bias * 200, 400)) for _ in range(3)]
            (tp_c if market == "tpex" else tw_c).setdefault(d, {})[code] = [fo, tr, de, fo + tr + de]
    return {"twse": twse, "tpex": tpex, "twse_chips": tw_c, "tpex_chips": tp_c, "info": info}
