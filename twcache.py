# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""本機增量資料快取；只存成功回應的資料，不存 Token 或請求網址。"""
import contextlib
import datetime as dt
import hashlib
import json
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CACHE_DIR = Path(os.environ.get("TWBOARD_CACHE_DIR", str(Path(__file__).resolve().parent / ".twboard-cache")))
TTL = 900               # 近期資料再確認的間隔（秒）
RECENT_DAYS = 7
_local = threading.local()
_io_lock = threading.RLock()
_state_lock = threading.Lock()      # 平行抓取時多執行緒共用同一份進度狀態
_conn_local = threading.local()     # 每個執行緒重用一條 sqlite 連線，不必每次開檔
_adopted = set()                    # 本次程序已搬過的舊快取鍵，不必每次查詢都再檢查一次
_key_locks = {}                     # 同一個資料鍵同時只讓一個執行緒抓（多檔同時要大盤指數時只抓一次）


@contextlib.contextmanager
def _key_lock(key):
    with _state_lock:
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:
        yield


def today():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()


@contextlib.contextmanager
def operation(callback=None):
    previous = getattr(_local, "state", None)
    state = {"stage": "準備", "detail": "", "cache_hits": 0, "network_requests": 0,
             "reused_days": 0, "downloaded_days": 0, "warnings": [], "offline": False, "offline_hosts": [],
             "callback": callback}
    _local.state = state
    try:
        yield state
    finally:
        _local.state = previous


def state():
    return getattr(_local, "state", None)


def public_info():
    return {k: v for k, v in (state() or {}).items() if k != "callback"}


def current_stage():
    """工作執行緒有自己的階段名稱（例如同時抓「三大法人」與「融資融券」時各自報各自的）。"""
    return getattr(_local, "stage", None) or (state() or {}).get("stage", "資料")


def report(stage=None, detail=None):
    s = state()
    if not s:
        return
    tstage = getattr(_local, "stage", None)
    with _state_lock:
        if stage is not None and tstage is None:
            s["stage"] = stage
        if detail is not None:
            s["detail"] = (tstage + "：" + detail) if tstage else detail
    if s["callback"]:
        s["callback"](public_info())


def count(key, amount=1):
    s = state()
    if s:
        with _state_lock:
            s[key] += amount
        report()


def warn(message):
    s = state()
    if s:
        with _state_lock:
            if message not in s["warnings"]:
                s["warnings"].append(message)
    report(detail=message)


@contextlib.contextmanager
def bind(shared_state, stage=None):
    """讓工作執行緒接上主執行緒的進度狀態。"""
    prev_state, prev_stage = getattr(_local, "state", None), getattr(_local, "stage", None)
    _local.state, _local.stage = shared_state, stage
    try:
        yield
    finally:
        _local.state, _local.stage = prev_state, prev_stage


def parallel(tasks, max_workers=6):
    """同時執行多個 (stage, callable)，回傳依序排列的結果；任一個丟出例外就原樣往上丟。

    各資料集互不相依、都是等網路回應，平行跑之後一檔股票的等待時間從「各資料集相加」變成「最慢的那一個」。
    sqlite 寫入仍由 _io_lock 排隊，不會互相踩到。
    """
    shared = state()
    if len(tasks) <= 1 or max_workers <= 1:
        out = []
        for stage, fn in tasks:
            with bind(shared, stage):
                out.append(fn())
        return out

    def run(stage, fn):
        with bind(shared, stage):
            return fn()
    with ThreadPoolExecutor(max_workers=min(max_workers, len(tasks)), thread_name_prefix="twboard-io") as pool:
        futures = [pool.submit(run, stage, fn) for stage, fn in tasks]
        return [f.result() for f in futures]


def key_for(*values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _connect():
    """每個執行緒一條長期連線；快取目錄或檔案換了就重開。"""
    path = str(CACHE_DIR / "market.sqlite3")
    con = getattr(_conn_local, "con", None)
    if con is not None and getattr(_conn_local, "path", None) == path:
        try:
            con.execute("SELECT 1")
            return con
        except sqlite3.Error:
            try:
                con.close()
            except sqlite3.Error:
                pass
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=20, check_same_thread=False)
    try:
        con.execute("PRAGMA journal_mode=WAL")          # 讀寫互不阻塞，寫入也少做幾次 fsync
        con.execute("PRAGMA synchronous=NORMAL")
    except sqlite3.Error:
        pass
    con.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT, day TEXT, payload TEXT NOT NULL, fetched REAL NOT NULL, PRIMARY KEY(key,day))")
    if "kind" not in [r[1] for r in con.execute("PRAGMA table_info(cache)")]:
        con.execute("ALTER TABLE cache ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
    con.commit()
    _conn_local.con, _conn_local.path = con, path
    return con


@contextlib.contextmanager
def database():
    con = _connect()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise


def read(key, start="", end="9999-12-31"):
    try:
        with _io_lock, database() as con:
            rows = con.execute("SELECT day,payload,fetched FROM cache WHERE key=? AND day>=? AND day<=?", (key,start,end)).fetchall()
        return {d: (json.loads(p), ts) for d,p,ts in rows}
    except (OSError, sqlite3.Error, ValueError):
        warn("本機快取無法讀取，本次直接查詢資料來源。")
        return {}


def write(key, values, kind=""):
    try:
        stamp = time.time()
        rows = [(key,d,json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(",",":")),stamp,kind)
                for d,v in values.items()]
        with _io_lock, database() as con:
            con.executemany("INSERT OR REPLACE INTO cache (key,day,payload,fetched,kind) VALUES (?,?,?,?,?)", rows)
    except (OSError, sqlite3.Error, ValueError):
        warn("本次資料已取得，但無法寫入本機快取。")


def dates(start, end):
    d, stop = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while d <= stop:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def _settled(cached, now):
    """最近一個平日的資料已經到手（或在當天 22:00 後確認過是空的），一天內就不必再逐次確認近 7 日。

    收盤後的日資料不會再變，重查只是白白多打幾次 API、多等幾秒。
    法人、融資券要到傍晚甚至晚上才齊，所以「今天還是空的」在 22:00 前不算數，會照 TTL 再確認。
    """
    last_weekday = today()
    while last_weekday.weekday() >= 5:
        last_weekday -= dt.timedelta(days=1)
    entry = cached.get(last_weekday.isoformat())
    if not entry or now - entry[1] >= 86400:
        return False
    if entry[0]:
        return True
    fetched_at = dt.datetime.fromtimestamp(entry[1], dt.timezone(dt.timedelta(hours=8)))
    return fetched_at.date() > last_weekday or fetched_at.hour >= 22


def range_data(key, start, end, fetch, required_dates=None, max_age=None, require_complete=False,
               refresh_recent=False, recent_ttl=None):
    """按日記錄成功涵蓋區間；補抓缺日，近期七日過期後重新確認。

    recent_ttl：近 7 日重新確認的間隔，預設 TTL；不常變動的資料集（除權息）可以放寬到跟 max_age 一樣。
    """
    with _key_lock(key):
        return _range_data(key, start, end, fetch, required_dates, max_age, require_complete, refresh_recent, recent_ttl)


def _range_data(key, start, end, fetch, required_dates, max_age, require_complete, refresh_recent, recent_ttl):
    wanted = list(dates(start, end))
    cached = read(key, start, end)
    recent = (today() - dt.timedelta(days=RECENT_DAYS)).isoformat()
    now = time.time()
    required = set(required_dates or [])
    ttl = TTL if recent_ttl is None else recent_ttl
    settled = not refresh_recent and _settled(cached, now)
    pending = [d for d in wanted if d not in cached or (refresh_recent and d >= recent) or
               ((d >= recent and not settled or (d in required and not cached[d][0])) and now-cached[d][1] >= ttl) or
               (max_age is not None and d in cached and now-cached[d][1] >= max_age)]
    reused = len(wanted)-len(pending)
    count("reused_days", reused)
    if reused:
        count("cache_hits")
    report(detail="沿用 %d 日快取，待補抓／確認 %d 日" % (reused,len(pending)))
    groups = []
    for d in pending:
        if groups and dt.date.fromisoformat(d)-dt.date.fromisoformat(groups[-1][-1]) == dt.timedelta(days=1):
            groups[-1].append(d)
        else:
            groups.append([d])
    have_success = bool(cached)
    refreshed = 0
    for index, group in enumerate(groups):
        report(detail="補抓／確認 %s～%s（%d/%d 段）" % (group[0],group[-1],index+1,len(groups)))
        count("network_requests")
        try:
            rows = fetch(group[0], group[-1])
        except Exception:
            rows = None
        if not isinstance(rows, list) or any(not isinstance(r,dict) or not isinstance(r.get("date"),str) for r in rows):
            warn("%s：部分日期更新失敗，已保留原資料；缺漏區間下次重試。" % current_stage())
            continue
        # 成功但空白的日期也記錄，避免假日／上市前區間一再查詢。
        grouped = {d: [] for d in group}
        for row in rows:
            if row["date"] in grouped:
                grouped[row["date"]].append(row)
        # 暫時空白的更新不可抹掉已知歷史；保留舊時間戳以便下次重試。
        omitted = [d for d in group if not grouped[d] and cached.get(d,([],0))[0]]
        for d in omitted:
            del grouped[d]
        if omitted:
            warn("%s：來源未回傳部分已知日期，保留先前資料並待重試。" % current_stage())
        write(key, grouped)
        stamp = time.time()
        cached.update({d:(v,stamp) for d,v in grouped.items()})
        count("downloaded_days",len(grouped))
        refreshed += len(grouped)
        have_success = True
    report(detail="資料整理完成；沿用 %d 日，成功補抓／確認 %d 日" % (reused,refreshed))
    if require_complete and any(d not in cached for d in wanted):
        return None
    return [row for d in wanted for row in cached.get(d,([],0))[0]] if have_success else None


def adopt(new_key, old_keys):
    """把舊鍵底下的資料搬到新鍵（新鍵已有的日期不覆蓋），然後刪掉舊鍵。
    用在快取鍵規則改版時沿用既有資料，不必整批重抓。"""
    memo = (str(CACHE_DIR), new_key)
    if memo in _adopted:
        return
    try:
        with _io_lock, database() as con:
            for old in old_keys:
                if old == new_key:
                    continue
                con.execute("INSERT OR IGNORE INTO cache (key,day,payload,fetched,kind) "
                            "SELECT ?,day,payload,fetched,kind FROM cache WHERE key=?", (new_key, old))
                con.execute("DELETE FROM cache WHERE key=?", (old,))
        _adopted.add(memo)
    except (OSError, sqlite3.Error):
        pass


MARKET_DAY_KEEP = 200      # 證交所「全市場單日」資料保留天數（法人／融資券最多只回看 60 個交易日）
GENERAL_KEEP = 1100        # 其他資料保留天數（顯示 500 日＋暖身約需 960 個日曆天）
PRUNE_EVERY = 86400


def prune(force=False):
    """刪除用不到的舊資料，回傳刪除筆數。每天最多實際執行一次。"""
    try:
        now = time.time()
        with _io_lock, database() as con:
            con.execute("CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT)")
            row = con.execute("SELECT value FROM meta WHERE name='pruned'").fetchone()
            if not force and row and now - float(row[0]) < PRUNE_EVERY:
                return 0
            old_day = (today() - dt.timedelta(days=GENERAL_KEEP)).isoformat()
            n = con.execute("DELETE FROM cache WHERE kind='market-day' AND fetched<?",
                            (now - MARKET_DAY_KEEP * 86400,)).rowcount
            n += con.execute("DELETE FROM cache WHERE kind<>'market-day' AND day<>'' AND day<?", (old_day,)).rowcount
            n += con.execute("DELETE FROM cache WHERE kind<>'market-day' AND day='' AND fetched<?",
                             (now - GENERAL_KEEP * 86400,)).rowcount
            con.execute("INSERT OR REPLACE INTO meta VALUES ('pruned',?)", (str(now),))
        if n:
            with _io_lock:
                try:
                    _connect().execute("VACUUM")      # 沿用本執行緒的連線；其他連線都在 _io_lock 外閒置
                except sqlite3.Error:
                    pass
        return n
    except (OSError, sqlite3.Error, ValueError):
        return 0


def stats():
    try:
        with _io_lock, database() as con:
            rows, size = con.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)),0) FROM cache").fetchone()
        return {"rows": rows, "payload_bytes": size}
    except (OSError, sqlite3.Error):
        return {"rows": 0, "payload_bytes": 0}


def response(key, fetch, valid, max_age, transform=None, kind="", legacy_key=None):
    """證交所整月／全市場單日回應可跨股票共用。失敗不覆盖成功快取。

    transform：存檔前先把原始回應轉成精簡格式（呼叫端拿到的也是轉換後的結果）。
    legacy_key：舊版把整份原始回應存在這個鍵；找得到就轉換後搬到新鍵，不必重抓。
    """
    with _key_lock(key):
        return _response(key, fetch, valid, max_age, transform, kind, legacy_key)


def _response(key, fetch, valid, max_age, transform, kind, legacy_key):
    if legacy_key and transform and not read(key).get(""):
        old = read(legacy_key).get("")
        if old and valid(old[0]):
            try:
                write(key, {"": transform(old[0])}, kind)
                with _io_lock, database() as con:
                    con.execute("UPDATE cache SET fetched=? WHERE key=? AND day=''", (old[1], key))
                    con.execute("DELETE FROM cache WHERE key=?", (legacy_key,))
            except Exception:
                pass
    cached = read(key).get("")
    if cached and (max_age is None or time.time()-cached[1] < max_age):
        count("cache_hits")
        report(detail=(state() or {}).get("detail", "")+" · 使用本機快取")
        return cached[0]
    count("network_requests")
    report(detail=(state() or {}).get("detail", "")+" · 向資料來源查詢")
    try:
        data = fetch()
    except Exception:
        data = None
    if valid(data):
        if transform:
            data = transform(data)
        write(key,{"":data},kind)
        return data
    if cached:
        count("cache_hits")
        warn("%s：更新失敗，沿用先前成功資料。" % (current_stage()))
        return cached[0]
    warn("%s：本次未取得資料，下次將重試。" % (current_stage()))
    return None
