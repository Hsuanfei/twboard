# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""Comparison notes and named filters shared by the local server and batch reports."""
import json
import math
import os
from pathlib import Path
import tempfile


def notes(d):
    a, cp = d.get("avail", {}), d.get("chip", {})
    result = []
    if d.get("bars_count", 0) < a.get("need_days", 0):
        result.append("價量 %s/%s 日" % (d.get("bars_count", 0), a["need_days"]))
    if cp.get("coverage20", 0) < 20:
        result.append("法人 %s/20 日" % cp.get("coverage20", 0))
    if not a.get("margin_current"):
        result.append("融資券無資料" if not a.get("margin") else
                      "融資券日期落後" if a.get("margin_latest") != d.get("last_date") else "融資券欄位缺漏")
    if not a.get("indicators_ready"):
        result.append("指標筆數不足")
    if (d.get("fetch_info") or {}).get("warnings"):
        result.append("更新有缺漏")
    if not (d.get("dividends") or {}).get("available"):
        result.append("除權息未完整取得")
    if not (d.get("bench") or {}).get("d20"):
        result.append("大盤基準不足")
    if (d.get("dividends") or {}).get("recent"):
        result.append("近60日有除權息")
    return result


def bollinger_label(b):
    if not b or b.get("upper") is None:
        return "資料不足"
    parts = ["通道收斂"] if b.get("squeeze") else []
    pb = b.get("percent_b")
    parts.append("今日突破上軌" if b.get("break_up") else
                 "今日跌破下軌" if b.get("break_down") else
                 "上軌外" if pb is not None and pb > 1 else
                 "下軌外" if pb is not None and pb < 0 else
                 "零寬度" if b.get("width") == 0 else "通道內")
    if b.get("width_rank") is None:
        parts.append("收斂歷史不足")
    return " · ".join(parts)


def normalize(filters):
    if not isinstance(filters, dict) or set(filters) - {"query", "bb", "score", "rs", "chip", "adx", "di"}:
        raise ValueError("篩選條件格式不正確")
    query, bb = filters.get("query", ""), filters.get("bb", "all")
    score, rs, chip = filters.get("score"), filters.get("rs", False), filters.get("chip", False)
    if not isinstance(query, str) or len(query) > 100 or any(ord(c) < 32 for c in query):
        raise ValueError("搜尋文字請填 100 個字以內")
    if not isinstance(bb, str) or bb not in ("all", "squeeze", "break_up", "break_down", "above", "below"):
        raise ValueError("布林條件無效")
    if score is not None and (type(score) not in (float, int) or not math.isfinite(score) or not 0 <= score <= 100):
        raise ValueError("最低綜合分請填 0～100，或留空")
    if type(rs) is not bool or type(chip) is not bool:
        raise ValueError("勾選條件格式不正確")
    adx, di = filters.get("adx"), filters.get("di", "all")
    if adx is not None and (type(adx) not in (float,int) or not math.isfinite(adx) or not 0 <= adx <= 100):
        raise ValueError("最低 ADX 請填 0～100，或留空")
    if not isinstance(di,str) or di not in ("all","bull","bear"):
        raise ValueError("DMI 方向條件無效")
    return dict(query=query.strip(), bb=bb, score=score, rs=rs, chip=chip, adx=adx, di=di)


def preset_path():
    return Path(os.environ.get("TWBOARD_FILTER_FILE") or Path(__file__).with_name("filter_presets.json"))


def clean_name(name):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 30 or any(ord(c) < 32 for c in name):
        raise ValueError("條件名稱請填 1～30 個字")
    return name.strip()


def load_presets():
    path = preset_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict) or len(data) > 50:
            raise ValueError()
        if any(clean_name(n) != n for n in data):
            raise ValueError()
        return {n: normalize(f) for n, f in data.items()}
    except (ValueError, UnicodeError):
        raise ValueError("filter_presets.json 格式損壞，請先修復或更名；原檔未覆寫") from None


def update_preset(name, filters=None, delete=False):
    # The server serializes read/modify/write with its process lock.
    name = clean_name(name)
    data = load_presets()
    if delete:
        if name not in data:
            raise ValueError("找不到這組條件，請重新載入頁面")
        del data[name]
    else:
        if name not in data and len(data) >= 50:
            raise ValueError("最多儲存 50 組篩選條件")
        data[name] = normalize(filters)
    path = preset_path()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name+".", suffix=".tmp", delete=False) as f:
            temporary = f.name
            json.dump(data, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return data


def csv_cell(value):
    # Prevent externally sourced labels from being evaluated as spreadsheet formulas.
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value
