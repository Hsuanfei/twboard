# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""K 線型態、跳空缺口、頭肩型態，以及「這檔股票過去出現同一型態之後」的漲跌統計（0928a）。

全部用未還原日K（開、高、低、收）判斷，只用到當天以前的資料，不預測未來。
統計只描述這檔股票自己的歷史，樣本少、相鄰事件重疊，不代表之後也會如此。
"""
import datetime as _dt

# (鍵, 名稱, 圖上短字, 多空, 判斷規則)
PATTERNS = [
    ("bull_engulf", "多頭吞噬", "吞", "bull", "前 5 日走弱後，前一根黑K的實體被今天的紅K實體完全包住"),
    ("bear_engulf", "空頭吞噬", "吞", "bear", "前 5 日走強後，前一根紅K的實體被今天的黑K實體完全包住"),
    ("morning_star", "晨星", "晨", "bull", "下跌中：長黑K → 實體很小、位置更低的K → 收過長黑K實體一半的紅K"),
    ("evening_star", "暮星", "暮", "bear", "上漲中：長紅K → 實體很小、位置更高的K → 收破長紅K實體一半的黑K"),
    ("doji", "十字線", "十", "neutral", "實體不到當日振幅的 10%（開收幾乎同價），多空拉鋸"),
    ("hammer", "錘子線", "錘", "bull", "前 5 日走弱後出現：下影線至少是實體 2 倍、上影線很短"),
    ("hanging_man", "吊人線", "吊", "bear", "前 5 日走強後出現：下影線至少是實體 2 倍、上影線很短"),
    ("shooting_star", "流星線", "流", "bear", "前 5 日走強後出現：上影線至少是實體 2 倍、下影線很短"),
    ("three_white", "紅三兵", "三", "bull", "連續 3 根紅K、收盤一天比一天高，每根都開在前一根實體內、收在高點附近"),
    ("three_black", "黑三鴉", "三", "bear", "連續 3 根黑K、收盤一天比一天低，每根都開在前一根實體內、收在低點附近"),
    ("gap_up", "向上跳空缺口", "缺", "bull", "今天最低價高於昨天最高價，且缺口 ≥ 0.5%；價格回到缺口下緣才算回補"),
    ("gap_down", "向下跳空缺口", "缺", "bear", "今天最高價低於昨天最低價，且缺口 ≥ 0.5%；價格回到缺口上緣才算回補"),
    ("hs_top", "頭肩頂", "頭肩頂", "bear", "三個高點中間最高、兩肩高度相近；收盤跌破兩個低點連成的頸線才算確認"),
    ("hs_bottom", "頭肩底", "頭肩底", "bull", "三個低點中間最低、兩肩高度相近；收盤突破兩個高點連成的頸線才算確認"),
]
KEYS = [p[0] for p in PATTERNS]
GAP_MIN = 0.005          # 缺口至少 0.5%（相對前一日收盤），太小的缺口在低價股很常見，意義不大
PIVOT_K = 5              # 轉折點：左右各 5 根 K 棒內的最高／最低
HS_MAX_SPAN = 120        # 左肩到右肩最多幾根
HS_WAIT = 40             # 右肩之後最多等幾根 K 棒突破頸線
HORIZONS = (5, 10)


def _r(v, nd=2):
    return None if v is None else round(v, nd)


def _defs():
    return [{"key": k, "name": n, "short": s, "dir": d, "rule": rule} for k, n, s, d, rule in PATTERNS]


def candles(o, h, l, c):
    """單根與多根 K 線型態。回傳 {鍵: [出現位置]}，位置是型態完成的那一根。"""
    n = len(c)
    out = {k: [] for k in KEYS}
    body = [abs(c[i] - o[i]) for i in range(n)]
    rng = [h[i] - l[i] for i in range(n)]
    upper = [h[i] - max(o[i], c[i]) for i in range(n)]
    lower = [min(o[i], c[i]) - l[i] for i in range(n)]
    avg_body = [None] * n
    acc = 0.0
    for i in range(n):
        acc += body[i]
        if i >= 10:
            acc -= body[i - 10]
        if i >= 9:
            avg_body[i] = acc / 10.0

    def down(i):                 # 型態出現前的短線方向：前一日收盤低於 5 日前
        return i >= 6 and c[i - 1] < c[i - 6]

    def up(i):
        return i >= 6 and c[i - 1] > c[i - 6]

    for i in range(1, n):
        if rng[i] <= 0 or c[i] <= 0:
            continue
        # 十字線優先：實體極小時不再判斷錘子、吊人、流星
        is_doji = body[i] <= 0.1 * rng[i] and rng[i] >= 0.004 * c[i]
        if is_doji:
            out["doji"].append(i)
        # 吞噬
        if body[i - 1] > 0 and body[i] > body[i - 1]:
            if down(i) and c[i - 1] < o[i - 1] and c[i] > o[i] and o[i] <= c[i - 1] and c[i] >= o[i - 1]:
                out["bull_engulf"].append(i)
            elif up(i) and c[i - 1] > o[i - 1] and c[i] < o[i] and o[i] >= c[i - 1] and c[i] <= o[i - 1]:
                out["bear_engulf"].append(i)
        # 錘子／吊人／流星（實體要有一點、影線夠長）
        if not is_doji and body[i] > 0:
            hammer_shape = lower[i] >= 2 * body[i] and lower[i] >= 0.5 * rng[i] and upper[i] <= 0.15 * rng[i]
            star_shape = upper[i] >= 2 * body[i] and upper[i] >= 0.5 * rng[i] and lower[i] <= 0.15 * rng[i]
            if hammer_shape and down(i):
                out["hammer"].append(i)
            elif hammer_shape and up(i):
                out["hanging_man"].append(i)
            elif star_shape and up(i):
                out["shooting_star"].append(i)
        # 晨星／暮星（三根：i-2 長K、i-1 小K、i 反向K）
        if i >= 12:
            a, b = i - 2, i - 1
            long_a = body[a] > 0 and body[a] >= avg_body[a - 1]
            small_b = body[b] <= 0.35 * body[a]
            mid_a = (o[a] + c[a]) / 2.0
            center_b = (o[b] + c[b]) / 2.0
            trend_down = c[a - 1] < c[a - 6]
            trend_up = c[a - 1] > c[a - 6]
            if long_a and small_b and c[a] < o[a] and center_b < c[a] and c[i] > o[i] and c[i] >= mid_a and trend_down:
                out["morning_star"].append(i)
            elif long_a and small_b and c[a] > o[a] and center_b > c[a] and c[i] < o[i] and c[i] <= mid_a and trend_up:
                out["evening_star"].append(i)
        # 紅三兵／黑三鴉（連續出現時只記第一次，避免四連紅記兩次）
        if i >= 2 and avg_body[i] is not None:
            a, b = i - 2, i - 1
            size_ok = all(body[j] >= 0.5 * avg_body[i] for j in (a, b, i))
            if (size_ok and all(c[j] > o[j] for j in (a, b, i)) and c[a] < c[b] < c[i]
                    and o[a] < o[b] <= c[a] and o[b] < o[i] <= c[b]
                    and all(upper[j] <= 0.4 * body[j] for j in (a, b, i))):
                if not out["three_white"] or out["three_white"][-1] < i - 2:
                    out["three_white"].append(i)
            elif (size_ok and all(c[j] < o[j] for j in (a, b, i)) and c[a] > c[b] > c[i]
                    and o[a] > o[b] >= c[a] and o[b] > o[i] >= c[b]
                    and all(lower[j] <= 0.4 * body[j] for j in (a, b, i))):
                if not out["three_black"] or out["three_black"][-1] < i - 2:
                    out["three_black"].append(i)
    return out


def gaps(h, l, c):
    """跳空缺口：[{i, lo, hi, dir, fill}]，fill 是完全回補那一根（尚未回補為 None）。"""
    out = []
    n = len(c)
    for i in range(1, n):
        prev = c[i - 1]
        if not prev or prev <= 0:
            continue
        if l[i] > h[i - 1] and (l[i] - h[i - 1]) / prev >= GAP_MIN:
            lo, hi = h[i - 1], l[i]
            fill = next((j for j in range(i + 1, n) if l[j] <= lo), None)
            out.append({"i": i, "lo": lo, "hi": hi, "dir": "up", "fill": fill})
        elif h[i] < l[i - 1] and (l[i - 1] - h[i]) / prev >= GAP_MIN:
            lo, hi = h[i], l[i - 1]
            fill = next((j for j in range(i + 1, n) if h[j] >= hi), None)
            out.append({"i": i, "lo": lo, "hi": hi, "dir": "down", "fill": fill})
    return out


def pivots(h, l, k=PIVOT_K):
    """左右各 k 根內的最高（peak）與最低（trough），相鄰同類只留更極端的一個，形成高低交錯的序列。"""
    n = len(h)
    raw = []
    for i in range(k, n - k):
        hi_win = h[i - k:i + k + 1]
        lo_win = l[i - k:i + k + 1]
        is_peak = h[i] == max(hi_win) and h[i] > h[i - 1]
        is_trough = l[i] == min(lo_win) and l[i] < l[i - 1]
        if is_peak and is_trough:
            continue                       # 同一根同時是最高與最低（大振幅），方向不明，略過
        if is_peak:
            raw.append((i, "P", h[i]))
        elif is_trough:
            raw.append((i, "T", l[i]))
    seq = []
    for p in raw:
        if seq and seq[-1][1] == p[1]:
            better = p[2] > seq[-1][2] if p[1] == "P" else p[2] < seq[-1][2]
            if better:
                seq[-1] = p
        else:
            seq.append(p)
    return seq


def head_shoulders(h, l, c):
    """逐日確認轉折與頸線；已確認訊號不因未來轉折重繪。

    轉折需右側 PIVOT_K 根才可知，統計起點是可知後首次仍突破頸線的收盤。
    """
    n = len(c)
    seq, active, out, seen = [], [], [], set()

    def candidate(five):
        kinds = "".join(p[1] for p in five)
        if kinds not in ("PTPTP", "TPTPT"):
            return None
        top = kinds == "PTPTP"
        (ls_i, _, ls), (t1_i, _, t1), (hd_i, _, hd), (t2_i, _, t2), (rs_i, _, rs) = five
        sign = 1 if top else -1
        shoulder_hi = max(ls, rs) if top else min(ls, rs)
        neck_ref = max(t1, t2) if top else min(t1, t2)
        height = (hd - (t1 + t2) / 2.0) * sign
        ok = (height > 0 and (hd - shoulder_hi) * sign >= 0.15 * height
              and abs(ls - rs) <= 0.5 * height
              and ((min(ls, rs) - neck_ref) * sign if top else (neck_ref - max(ls, rs))) > 0
              and height / hd >= 0.03
              and abs(t2 - t1) <= 0.6 * height
              and rs_i - ls_i <= HS_MAX_SPAN
              and all(five[j + 1][0] - five[j][0] >= 3 for j in range(4))
              and 0.4 <= (rs_i - hd_i) / max(1, hd_i - ls_i) <= 2.5)
        if not ok:
            return None
        return {"key": "hs_top" if top else "hs_bottom", "top": top,
                "points": [(p[0], p[2]) for p in five], "head": hd,
                "t1": t1_i, "y1": t1, "slope": (t2 - t1) / (t2_i - t1_i),
                "right": rs_i, "known": rs_i + PIVOT_K}

    def finish(x, end, confirmed):
        return {"key": x["key"], "points": x["points"],
                "neck": (x["t1"], x["y1"], end, x["y1"] + x["slope"] * (end - x["t1"])),
                "break": end if confirmed else None, "confirmed": confirmed,
                "known": x["known"]}

    for t in range(n):
        i = t - PIVOT_K
        if i >= PIVOT_K:
            peak = h[i] == max(h[i-PIVOT_K:t+1]) and h[i] > h[i-1]
            trough = l[i] == min(l[i-PIVOT_K:t+1]) and l[i] < l[i-1]
            if peak != trough:
                p = (i, "P" if peak else "T", h[i] if peak else l[i])
                changed = False
                if seq and seq[-1][1] == p[1]:
                    if (p[2] > seq[-1][2]) if peak else (p[2] < seq[-1][2]):
                        seq[-1] = p
                        changed = True
                else:
                    seq.append(p)
                    changed = True
                if changed and len(seq) >= 5:
                    x = candidate(seq[-5:])
                    signature = tuple(p[0] for p in seq[-5:])
                    if x and signature not in seen:
                        seen.add(signature)
                        # Confirming the right shoulder must not overlook prior invalidation.
                        invalid = any((h[j] > x["head"]) if x["top"] else (l[j] < x["head"])
                                      for j in range(x["right"] + 1, t + 1))
                        if not invalid:
                            active.append(x)
        pending = []
        for x in active:
            invalid = h[t] > x["head"] if x["top"] else l[t] < x["head"]
            if invalid or t > x["right"] + HS_WAIT:
                continue
            neck = x["y1"] + x["slope"] * (t - x["t1"])
            broken = c[t] < neck if x["top"] else c[t] > neck
            if broken:
                out.append(finish(x, t, True))
            else:
                pending.append(x)
        active = pending
    out.extend(finish(x, n - 1, False) for x in active if n - 1 < x["right"] + HS_WAIT)
    return out


def _stats(idxs, c, n):
    res = {"total": len(idxs)}
    for hz in HORIZONS:
        rets = [(c[i + hz] / c[i] - 1) * 100.0 for i in idxs if i + hz < n and c[i] > 0]
        res["n%d" % hz] = len(rets)
        res["up%d" % hz] = _r(sum(1 for x in rets if x > 0) / len(rets) * 100.0, 1) if rets else None
        res["avg%d" % hz] = _r(sum(rets) / len(rets)) if rets else None
    return res


def _span_label(d0, d1):
    try:
        days = (_dt.date.fromisoformat(d1) - _dt.date.fromisoformat(d0)).days
    except (TypeError, ValueError):
        return ""
    years = days / 365.25
    if years >= 9.5:
        return "近 %d 年" % round(years)
    if years >= 1:
        return "近 %.1f 年" % years
    return "近 %d 個月" % max(1, round(days / 30.4))


def analyse(date, o, h, l, c, window=250):
    """在完整歷史上偵測型態並統計，只把最後 window 根內的標記傳給畫面（索引改成相對於視窗起點）。"""
    n = len(c)
    if n < 12:
        return None
    w0 = max(0, n - window)
    found = candles(o, h, l, c)
    gp = gaps(h, l, c)
    for g in gp:
        found["gap_up" if g["dir"] == "up" else "gap_down"].append(g["i"])
    hs = head_shoulders(h, l, c)
    for x in hs:
        if x["confirmed"]:
            found[x["key"]].append(x["break"])
    for k in found:
        found[k] = sorted(set(found[k]))

    def fwd(i, hz):
        return _r((c[i + hz] / c[i] - 1) * 100.0) if i + hz < n and c[i] > 0 else None

    events = []
    for k in KEYS:
        for i in found[k]:
            if i >= w0:
                events.append({"i": i - w0, "key": k, "f5": fwd(i, 5), "f10": fwd(i, 10)})
    events.sort(key=lambda e: (e["i"], KEYS.index(e["key"])))
    gap_view = []
    for g in gp:
        end = g["fill"] if g["fill"] is not None else n - 1
        if end < w0:
            continue
        gap_view.append({"i": g["i"] - w0, "end": end - w0, "lo": _r(g["lo"]), "hi": _r(g["hi"]), "dir": g["dir"],
                         "filled": g["fill"] is not None, "fill_date": date[g["fill"]] if g["fill"] is not None else None})
    hs_view = []
    for x in hs:
        if x["points"][0][0] < w0:
            continue
        i1, y1, i2, y2 = x["neck"]
        hs_view.append({"key": x["key"], "confirmed": x["confirmed"],
                        "points": [[i - w0, _r(y)] for i, y in x["points"]],
                        "neck": [[i1 - w0, _r(y1)], [i2 - w0, _r(y2)]],
                        "break": None if x["break"] is None else x["break"] - w0})
    base_idx = list(range(n))
    return {
        "defs": _defs(),
        "events": events, "gaps": gap_view, "hs": hs_view,
        "stats": {k: _stats(found[k], c, n) for k in KEYS},
        "baseline": _stats(base_idx, c, n),
        "span": {"from": date[0], "to": date[-1], "bars": n, "label": _span_label(date[0], date[-1])},
        "gap_min_pct": GAP_MIN * 100, "horizons": list(HORIZONS),
    }
