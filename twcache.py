# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""本機增量資料快取；只存成功回應的資料，不存 Token 或請求網址。"""
import atexit
import collections
import itertools
import types
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
_conn_local = types.SimpleNamespace()     # 在 _io_lock 內重用一條 sqlite 連線
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
    """共用一條長期連線；快取目錄換了先關閉舊連線。"""
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
    close_cache()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=20, check_same_thread=False)
    try:
        con.execute("PRAGMA journal_mode=WAL")          # 讀寫互不阻塞，寫入也少做幾次 fsync
        con.execute("PRAGMA synchronous=NORMAL")
    except sqlite3.Error:
        pass
    try:
        con.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT, day TEXT, payload TEXT NOT NULL, fetched REAL NOT NULL, PRIMARY KEY(key,day))")
        if "kind" not in [r[1] for r in con.execute("PRAGMA table_info(cache)")]:
            con.execute("ALTER TABLE cache ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
        # 1003a：每次送出的 FinMind 查詢（只記時間與結果，不記網址或 Token），重開程式也知道這一小時用了幾次。
        con.execute("CREATE TABLE IF NOT EXISTS usage_log (ts REAL NOT NULL, source TEXT NOT NULL, ok INTEGER, status INTEGER)")
        con.commit()
    except Exception:
        con.close()
        raise
    _conn_local.con, _conn_local.path = con, path
    return con


def close_cache():
    """關閉快取連線；切換目錄、清理測試與程序退出時釋放 Windows 檔案鎖。"""
    with _io_lock:
        con = getattr(_conn_local, "con", None)
        _conn_local.con, _conn_local.path = None, None
        if con is not None:
            con.close()


atexit.register(close_cache)


@contextlib.contextmanager
def database():
    # 讀寫原本即受同一把鎖保護；共用一條連線避免短命工作執行緒留下連線。
    with _io_lock:
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
        stamp = clock()
        rows = [(key,d,json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(",",":")),stamp,kind)
                for d,v in values.items()]
        with _io_lock, database() as con:
            con.executemany("INSERT OR REPLACE INTO cache (key,day,payload,fetched,kind) VALUES (?,?,?,?,?)", rows)
        _writes[0] += 1
    except (OSError, sqlite3.Error, ValueError):
        warn("本次資料已取得，但無法寫入本機快取。")


def write_many(items, kind=""):
    """一次寫入多個鍵（[(key, day, value), ...]），同一個交易；集保每週全市場摘要一次寫幾千檔用。"""
    try:
        stamp = clock()
        rows = [(k, d, json.dumps(v, ensure_ascii=False, allow_nan=False, separators=(",", ":")), stamp, kind)
                for k, d, v in items]
        with _io_lock, database() as con:
            con.executemany("INSERT OR REPLACE INTO cache (key,day,payload,fetched,kind) VALUES (?,?,?,?,?)", rows)
        _writes[0] += 1
        return True
    except (OSError, sqlite3.Error, ValueError):
        warn("本次資料已取得，但無法寫入本機快取。")
        return False


def dates(start, end):
    d, stop = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while d <= stop:
        yield d.isoformat()
        d += dt.timedelta(days=1)


# ==========================================================================
# 1003a：資料多久有效（依資料來源的公布時間，而不是固定幾分鐘）
# ==========================================================================
TW_TZ = dt.timezone(dt.timedelta(hours=8))


def clock():
    """目前時間（秒）；測試可以換掉。"""
    return time.time()


def _at(day, minutes):
    return (dt.datetime(day.year, day.month, day.day, tzinfo=TW_TZ) + dt.timedelta(minutes=minutes)).timestamp()


class Daily:
    """日資料：每天固定幾個時間點會有新資料（台灣時間）。

    releases：{星期幾(0=一): [距離午夜的分鐘數, ...]}；first：某一天的資料最早什麼時候可能出現（距離當天午夜的分鐘數）。
    快取裡的資料在「抓下來之後的下一個公布時間」以前都算有效；還不可能有資料的日子（例如收盤前的今天）不去查。
    近 7 日以外的日子抓過就定案，不再查（法人、融資券這類「股價有、資料還沒出來」的日子除外）。
    """
    quarterly = False
    span = False

    def __init__(self, name, releases, first, note):
        self.name, self.first, self.note = name, first, note
        self.releases = {w: sorted(v) for w, v in releases.items()}

    def next_release(self, ts):
        t = dt.datetime.fromtimestamp(ts, TW_TZ)
        for add in range(0, 15):
            day = t.date() + dt.timedelta(days=add)
            for m in self.releases.get(day.weekday(), ()):
                at = _at(day, m)
                if at > ts:
                    return at
        return ts + 7 * 86400

    def due(self, day):
        return _at(dt.date.fromisoformat(day), self.first)

    def expired(self, day, rows, fetched, now, recent, required):
        if day >= recent or (required and not rows):
            return now >= self.next_release(fetched)
        return False

    def refreshable(self, day, rows, recent):
        return day >= recent


def _hm(h, m=0):
    return h * 60 + m


WEEKDAYS, TUE_SAT = (0, 1, 2, 3, 4), (1, 2, 3, 4, 5)


def _releases(*groups):
    out = {}
    for days, times in groups:
        for w in days:
            out.setdefault(w, []).extend(times)
    return out


# 台股日資料：收盤後（14:30）、FinMind 股價（17:30）、法人／融資券／外資持股（約 21:00）、隔天早上再確認一次晚到的資料。
TW_DAILY = Daily("台股日資料", _releases((WEEKDAYS, [_hm(14, 30), _hm(17, 45), _hm(21, 45)]), (TUE_SAT, [_hm(8)])),
                 _hm(14, 30), "收盤後 14:30、17:45、21:45 與隔天 08:00 各確認一次")
# 除權息、分割這類一天最多變一次的資料：每天傍晚確認一次。
TW_ONCE = Daily("台股每日一次", _releases((WEEKDAYS, [_hm(18)])), _hm(14, 30), "每天 18:00 後確認一次")
# 證交所／櫃買官方資料：收盤後陸續公布，多確認幾次（不受 FinMind 額度限制）。
TW_OFFICIAL = Daily("證交所／櫃買", _releases((WEEKDAYS, [_hm(14, 30), _hm(15, 15), _hm(16), _hm(17), _hm(21, 30)]),
                                         (TUE_SAT, [_hm(8)])), _hm(13, 45), "收盤後 14:30～17:00 每小時、21:30 與隔天 08:00 各確認一次")
# 美股：美東收盤是台灣隔天清晨。
US_DAILY = Daily("美股", _releases((TUE_SAT, [_hm(6), _hm(9), _hm(18)])), 24 * 60 + _hm(5, 30),
                 "台灣時間隔天 06:00、09:00、18:00 各確認一次")
JP_DAILY = Daily("日股", _releases((WEEKDAYS, [_hm(15), _hm(18)]), (TUE_SAT, [_hm(8)])), _hm(14),
                 "15:00、18:00 與隔天 08:00 各確認一次")
FX_DAILY = Daily("匯率", _releases((WEEKDAYS, [_hm(11), _hm(16, 30), _hm(21)])), _hm(9, 30),
                 "11:00、16:30、21:00 各確認一次")
# 集保股權分散：每週五的資料，週六前後公布。
WEEKLY = Daily("每週資料", _releases(((5,), [_hm(10)]), ((0, 1), [_hm(9)])), 24 * 60,
               "每週六 10:00、週一與週二 09:00 各確認一次")


class Quarterly:
    """財報：每一季的資料在季底日期。到手後就定案；還沒公布時，只在法定公布期限前每週一確認一次，期限過後定案。"""
    quarterly = True
    span = True            # 要查的季底合併成一次查詢（中間的日子一起查，不必每一季各查一次）
    name, note = "財報", "最新一季到手後，下一季公布期才再查；公布期間每週一確認一次"
    DEADLINES = {3: (5, 15), 6: (8, 14), 9: (11, 14), 12: (3, 31)}       # 季底月份 → 法定公布期限（月, 日）
    GRACE = 10                                                         # 期限後再等 10 天（資料庫收錄需要時間）

    @staticmethod
    def quarter_end(day):
        d = dt.date.fromisoformat(day)
        return d.month in (3, 6, 9, 12) and (d + dt.timedelta(days=1)).day == 1

    def deadline(self, day):
        d = dt.date.fromisoformat(day)
        month, dd = self.DEADLINES[d.month]
        year = d.year + (1 if d.month == 12 else 0)
        return _at(dt.date(year, month, dd), 24 * 60) + self.GRACE * 86400

    def due(self, day):
        """季底的隔天起才可能有資料；其他日子永遠不會有財報，不必查。"""
        return _at(dt.date.fromisoformat(day), 24 * 60) if self.quarter_end(day) else float("inf")

    def next_check(self, fetched):
        t = dt.datetime.fromtimestamp(fetched, TW_TZ).date()
        monday = t + dt.timedelta(days=(7 - t.weekday()) % 7 or 7)
        at = _at(monday, _hm(9))
        if at <= fetched:
            at += 7 * 86400
        return at

    def expired(self, day, rows, fetched, now, recent, required):
        if rows or not self.quarter_end(day):
            return False
        final = self.deadline(day)
        if fetched >= final:
            return False
        return now >= min(self.next_check(fetched), final)

    def refreshable(self, day, rows, recent):
        """「重抓」：最近 140 天內、還沒有資料的季底再確認一次。"""
        return (not rows and self.quarter_end(day)
                and day >= (dt.date.fromisoformat(recent) - dt.timedelta(days=133)).isoformat())


QUARTERLY = Quarterly()
SCHEDULES = {"tw": TW_DAILY, "tw_once": TW_ONCE, "tw_official": TW_OFFICIAL, "us": US_DAILY, "jp": JP_DAILY, "fx": FX_DAILY,
             "weekly": WEEKLY, "quarterly": QUARTERLY}
RULES_TEXT = ["台股日線、法人、融資券：" + TW_DAILY.note + "；收盤前不查當天",
              "除權息、分割：" + TW_ONCE.note, "財報：" + QUARTERLY.note,
              "美股：" + US_DAILY.note, "近 7 日以前的資料抓過就不再查"]


def schedule_of(schedule):
    if schedule is None:
        return TW_DAILY
    return SCHEDULES[schedule] if isinstance(schedule, str) else schedule


def range_data(key, start, end, fetch, required_dates=None, max_age=None, require_complete=False,
               refresh_recent=False, recent_ttl=None, schedule=None):
    """按日記錄成功涵蓋區間；只補抓缺日，以及「抓下來之後資料來源又公布過新資料」的近期日子。

    schedule：資料的公布時間表（"tw" 台股日資料、"tw_once"、"us"、"jp"、"fx"、"weekly"、"quarterly"），預設台股日資料。
    refresh_recent：使用者按「重抓」，近 7 日（財報為最近一季）不論是否有效都重新確認。
    recent_ttl：1003a 起不再使用（改看公布時間），保留參數讓舊的呼叫端照常運作。
    """
    with _key_lock(key):
        return _range_data(key, start, end, fetch, required_dates, max_age, require_complete, refresh_recent,
                           schedule_of(schedule))


def _range_data(key, start, end, fetch, required_dates, max_age, require_complete, refresh_recent, sched):
    wanted = list(dates(start, end))
    cached = read(key, start, end)
    recent = (today() - dt.timedelta(days=RECENT_DAYS)).isoformat()
    now = clock()
    required = set(required_dates or [])
    pending, not_due = [], set()
    for d in wanted:
        entry = cached.get(d)
        if entry is None:
            # 還不可能有資料的日子（收盤前的今天、美股還沒收盤）不去查，也不算缺資料。
            if now < sched.due(d):
                not_due.add(d)
            else:
                pending.append(d)
            continue
        rows, fetched = entry
        if ((refresh_recent and sched.refreshable(d, rows, recent)) or
                (max_age is not None and now - fetched >= max_age) or
                (now >= sched.due(d) and sched.expired(d, rows, fetched, now, recent, d in required))):
            pending.append(d)
    reused = sum(1 for d in wanted if d in cached) - len([d for d in pending if d in cached])
    count("reused_days", reused)
    if reused:
        count("cache_hits")
    _note_activity("network" if pending else "cache")
    report(detail="沿用 %d 日快取，待補抓／確認 %d 日" % (reused,len(pending)))
    groups = []
    if pending and sched.span:
        groups = [list(dates(pending[0], pending[-1]))]
    for d in ([] if sched.span else pending):
        if groups and dt.date.fromisoformat(d)-dt.date.fromisoformat(groups[-1][-1]) == dt.timedelta(days=1):
            groups[-1].append(d)
        else:
            groups.append([d])
    have_success = bool(cached) or not pending
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
        stamp = clock()
        cached.update({d:(v,stamp) for d,v in grouped.items()})
        count("downloaded_days",len(grouped))
        refreshed += len(grouped)
        have_success = True
    report(detail="資料整理完成；沿用 %d 日，成功補抓／確認 %d 日" % (reused,refreshed))
    if require_complete and any(d not in cached and d not in not_due for d in wanted):
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
GENERAL_KEEP = 3800        # 其他資料保留天數：K 線型態、填息、季節性要用近 10 年日K（0930b 起由 1100 天放寬）
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


def response(key, fetch, valid, max_age, transform=None, kind="", legacy_key=None, schedule=None):
    """證交所整月／全市場單日回應可跨股票共用。失敗不覆盖成功快取。

    transform：存檔前先把原始回應轉成精簡格式（呼叫端拿到的也是轉換後的結果）。
    legacy_key：舊版把整份原始回應存在這個鍵；找得到就轉換後搬到新鍵，不必重抓。
    """
    with _key_lock(key):
        return _response(key, fetch, valid, max_age, transform, kind, legacy_key, schedule)


def _response(key, fetch, valid, max_age, transform, kind, legacy_key, schedule=None):
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
    now = clock()
    sched = schedule_of(schedule) if schedule is not None else None
    if cached and (max_age is None or now-cached[1] < max_age) and (sched is None or now < sched.next_release(cached[1])):
        count("cache_hits")
        _note_activity("cache")
        report(detail=(state() or {}).get("detail", "")+" · 使用本機快取")
        return cached[0]
    count("network_requests")
    _note_activity("network")
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


# ==========================================================================
# 1003a：用量紀錄、快取使用情形、資料庫大小
# ==========================================================================
_activity = collections.deque(maxlen=5000)     # (時間, "cache"|"network")：每次讀一份資料是直接沿用還是要連網
_usage_writes = itertools.count()
_stats_memo = {"at": 0.0, "dir": None, "data": None, "writes": -1}
_writes = [0]                                  # 寫入次數：資料庫有變動時，大小與筆數要重新計算


def _note_activity(kind):
    _activity.append((clock(), kind))


def activity(since):
    items = [k for t, k in list(_activity) if t >= since]
    return {"cache": items.count("cache"), "network": items.count("network")}


def log_request(source, ok, status, ts=None):
    try:
        with _io_lock, database() as con:
            con.execute("INSERT INTO usage_log (ts,source,ok,status) VALUES (?,?,?,?)",
                        (ts if ts is not None else clock(), source, 1 if ok else 0, status))
            if next(_usage_writes) % 200 == 0:
                con.execute("DELETE FROM usage_log WHERE ts<?", (clock() - 2 * 86400,))
    except (OSError, sqlite3.Error):
        pass


def request_log(source, since):
    """since 以後送出的查詢時間（由舊到新）。"""
    try:
        with _io_lock, database() as con:
            return [r[0] for r in con.execute("SELECT ts FROM usage_log WHERE source=? AND ts>=? ORDER BY ts", (source, since))]
    except (OSError, sqlite3.Error):
        return []


def stats_detail(max_age=30):
    """資料庫大小與筆數；畫面每幾秒問一次，30 秒內沿用上次的結果。"""
    now = clock()
    if (_stats_memo["data"] and _stats_memo["dir"] == str(CACHE_DIR) and now - _stats_memo["at"] < max_age
            and _stats_memo["writes"] == _writes[0]):
        return dict(_stats_memo["data"])
    seen = _writes[0]
    size = 0
    for suffix in ("", "-wal"):
        try:
            size += (CACHE_DIR / ("market.sqlite3" + suffix)).stat().st_size
        except OSError:
            pass
    try:
        with _io_lock, database() as con:
            rows = con.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
            keys = con.execute("SELECT COUNT(DISTINCT key) FROM cache").fetchone()[0]
    except (OSError, sqlite3.Error):
        rows = keys = None
    data = {"bytes": size, "rows": rows, "datasets": keys}
    _stats_memo.update({"at": now, "dir": str(CACHE_DIR), "data": data, "writes": seen})
    return dict(data)


def clear_all():
    """清空行情快取（用量紀錄保留）；回傳刪除筆數。"""
    with _io_lock, database() as con:
        n = con.execute("DELETE FROM cache").rowcount
    with _io_lock:
        try:
            _connect().execute("VACUUM")
        except sqlite3.Error:
            pass
    _adopted.clear()
    _writes[0] += 1
    return n
