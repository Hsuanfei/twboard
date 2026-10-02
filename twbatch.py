#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""
台股戰略產生器 — 每日批次
==========================
把自選群組（watchlists.json）裡的股票一次跑完，產出到 reports/日期/：

    每檔一份離線可開的戰略圖 HTML
    index.html   總覽表（依綜合分排序，可點進各檔）
    summary.csv  同一份總覽，方便用 Excel 追蹤

用法
----
    python twbatch.py                     # 跑 watchlists.json 裡的全部群組
    python twbatch.py --group 半導體       # 只跑一個群組
    python twbatch.py 2330 2317 0050      # 不用群組，直接給代號
    python twbatch.py --days 60 --source finmind
    python twbatch.py --keep 30           # 只保留最近 30 個日期資料夾

Token 請用環境變數 FINMIND_TOKEN 提供（不要寫在排程的命令列裡，命令列會留在工作排程器的設定中）。
"""
import argparse
import csv
import datetime as dt
import html
import os
import re
import shutil
import sys
import time

import twboard as T
import twcompare as C

HERE = os.path.dirname(os.path.abspath(__file__))


def safe_name(text):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", text).strip("_") or "stock"


def fmt(v, digits=2, signed=False, suffix=""):
    if v is None:
        return "—"
    return (("%+." if signed else "%.") + "%df" % digits) % v + suffix


def index_page(day, rows, failed, source_label):
    def cls(v):
        return "" if v is None else ("up" if v > 0 else "down" if v < 0 else "")
    body = []
    for r in rows:
        d = r["data"]
        rs = (d.get("bench") or {}).get("d20") or {}
        issues = C.notes(d)
        bb = d.get("bollinger") or {}
        body.append(
            "<tr><td><a href='%s'>%s</a><span>%s</span></td><td>%s</td>"
            "<td class='num'>%s</td><td class='num %s'>%s</td><td class='num'>%s</td>"
            "<td class='num %s'>%s</td><td class='num %s'>%s</td><td class='num %s'>%s</td>"
            "<td class='num'><b>%s</b></td><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td>%s</td><td class='num'>%s</td><td>%s / %s</td><td>%s</td><td class='warn'>%s</td></tr>" % (
                html.escape(r["file"]), html.escape(d["code"]), html.escape(d["name"]),
                html.escape("、".join(r["groups"]) or "—"),
                fmt(d["quote"]["close"]), cls(d["quote"]["chg_pct"]), fmt(d["quote"]["chg_pct"], 2, True, "%"),
                fmt(d["quote"]["vratio"], 2, False, " 倍"),
                cls(d["chip"]["net5"]), fmt(d["chip"]["net5"], 0, True),
                cls(d["chip"]["net20"]), fmt(d["chip"]["net20"], 0, True),
                cls(rs.get("rs")), fmt(rs.get("rs"), 2, True, " 點"),
                fmt(d["scores"]["overall"], 1), html.escape(d["plan"]["verdict"]),
                html.escape(d["last_date"]), fmt(bb.get("width"), 2, suffix="%"), fmt(bb.get("percent_b"), 3),
                fmt(bb.get("width_rank"), 1), html.escape(C.bollinger_label(bb)), fmt((d.get("dmi") or {}).get("adx"),1),
                fmt((d.get("dmi") or {}).get("plus_di"),1),fmt((d.get("dmi") or {}).get("minus_di"),1),
                html.escape((d.get("volume_analysis") or {}).get("state", "資料不足")), html.escape(" · ".join(issues) or "資料齊全")))
    fail_html = ("<p class='fail'>取不到資料：%s</p>" % html.escape("、".join(failed))) if failed else ""
    return """<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>%(day)s 每日總覽 · %(title)s</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0b0e14;color:#fff;font:13px/1.6 system-ui,"Segoe UI","Microsoft JhengHei",sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding:18px}h1{font-size:19px;margin:0 0 4px}.sub{color:#8b8f9a;font-size:12px;margin-bottom:14px}
.box{background:#151a24;border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:6px 12px;overflow:auto}
table{border-collapse:collapse;width:100%%;font-variant-numeric:tabular-nums}th{color:#c3c2b7;font-weight:600;text-align:left;
padding:9px 8px;border-bottom:1px solid rgba(255,255,255,.12);white-space:nowrap;font-size:12px}
td{padding:8px;border-bottom:1px solid rgba(255,255,255,.055);white-space:nowrap}td.num,th.num{text-align:right}
td span{display:block;color:#8b8f9a;font-size:11px}a{color:#6da7ec;font-weight:700;text-decoration:none}a:hover{text-decoration:underline}
.up{color:#e5484d}.down{color:#17a44b}.warn{color:#c3c2b7;font-size:11.5px;white-space:normal}.fail{color:#ff9d9d}
.legal{color:#8b8f9a;font-size:11px;line-height:1.8;margin-top:10px;border-top:1px solid rgba(255,255,255,.09);padding-top:9px}.legal a{color:#6da7ec}.legal b{color:#c3c2b7}
.note{color:#8b8f9a;font-size:11.5px;line-height:1.8;margin-top:12px}
</style></head><body><div class="wrap">
<h1>%(day)s 每日總覽</h1>
<div class="sub">%(title)s · %(credit)s · 資料來源 %(source)s · 產生於 %(now)s · 共 %(n)d 檔（依綜合分排序）</div>
<div class="box"><table><thead><tr><th>股票</th><th>群組</th><th class="num">收盤</th><th class="num">漲跌幅</th><th class="num">量比</th>
<th class="num">法人近5日(張)</th><th class="num">法人近20日(張)</th><th class="num">相對大盤20日</th><th class="num">綜合分</th>
<th>規則研判</th><th>股價日期</th><th>布林帶寬%%</th><th>布林%%B</th><th>帶寬百分位</th><th>布林狀態</th><th>ADX14</th><th>＋DI／−DI</th><th>量價方向</th><th>資料狀態</th></tr></thead><tbody>%(body)s</tbody></table></div>
%(fail)s
<p class="note">綜合分是公開資料套用固定規則換算的 0–100 相對刻度，不是勝率，也不是對未來報酬的預測；各檔的「規則分回測」分頁可以看這套分數在該檔股票上過去有沒有跟後續漲跌同方向。
相對大盤採雙方價格報酬（不含息）。布林採 20 日、2 倍標準差；帶寬百分位採 120 筆有效帶寬，歷史不足時不判斷收斂。紅漲綠跌。本頁為資料整理工具，不構成投資建議。</p>
%(legal)s
</div></body></html>""" % {"day": html.escape(day), "title": html.escape(T.APP_TITLE), "credit": html.escape(T.APP_CREDIT),
                          "source": html.escape(source_label), "now": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
                          "n": len(rows), "body": "".join(body), "fail": fail_html,
                          "legal": T.legal_html(exported=True)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=T.APP_TITLE + " — 每日批次")
    ap.add_argument("codes", nargs="*", help="股票代號；不給就讀 watchlists.json")
    ap.add_argument("--group", action="append", help="只跑指定群組，可重複指定")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--source", choices=["auto", "finmind", "twse", "demo"], default="auto")
    ap.add_argument("--out", default=os.path.join(HERE, "reports"))
    ap.add_argument("--keep", type=int, default=0, help="只保留最近 N 個日期資料夾（0＝全部保留）")
    ap.add_argument("--pause", type=float, default=1.0, help="每檔之間停幾秒，避免一口氣打太多查詢")
    a = ap.parse_args(argv)

    wanted = {}                                   # code -> [群組名稱]
    if a.codes:
        for c in a.codes:
            wanted.setdefault(c.strip().upper(), [])
    else:
        groups = T.load_watchlists()
        if a.group:
            missing = [g for g in a.group if g not in groups]
            if missing:
                raise SystemExit("找不到群組：%s（現有：%s）" % ("、".join(missing), "、".join(groups) or "無"))
            groups = {g: groups[g] for g in a.group}
        for name, codes in groups.items():
            for c in codes:
                wanted.setdefault(c, []).append(name)
    if not wanted:
        raise SystemExit("沒有要跑的股票。請在互動版頁面的「自選群組」存一個群組，或直接給代號：python twbatch.py 2330 2317")

    token = os.environ.get("FINMIND_TOKEN", "")
    day = T.TC.today().isoformat()
    folder = os.path.join(a.out, day)
    os.makedirs(folder, exist_ok=True)
    T.TC.prune()
    tag = T.load_echarts("inline")
    rows, failed = [], []
    T.log(T.legal_text())
    T.log("批次開始：%d 檔 → %s" % (len(wanted), folder))
    for n, (code, groups) in enumerate(wanted.items(), 1):
        T.log("[%d/%d] %s" % (n, len(wanted), code))
        try:
            with T.TC.operation():
                raw = T.fetch_raw(code, max(a.days, 120), a.source, token, None, verbose=False)
                info = T.TC.public_info()
            if not raw:
                raise ValueError("取不到資料")
            d = T.analyse(code, raw, a.days)
            d["fetch_info"] = dict(info, mode="demo" if a.source == "demo" else
                                   "incremental" if info["network_requests"] else "local")
            name = "%s_%s.html" % (code, safe_name(d["name"]))
            with open(os.path.join(folder, name), "w", encoding="utf-8") as f:
                f.write(T.render(d, tag))
            rows.append({"data": d, "file": name, "groups": groups})
            T.log("      ✓ %s 收盤 %s　綜合分 %s　%s" % (d["last_date"], d["quote"]["close"],
                                                     d["scores"]["overall"], d["plan"]["verdict"]))
        except Exception as e:                                       # noqa: BLE001
            failed.append(code)
            T.log("      x 失敗：%s" % (e if isinstance(e, ValueError) else type(e).__name__))
        if n < len(wanted):
            time.sleep(max(0.0, a.pause))

    rows.sort(key=lambda r: (r["data"]["scores"]["overall"] is None, -(r["data"]["scores"]["overall"] or 0)))
    label = "、".join(sorted({r["data"]["source"] for r in rows})) or a.source
    with open(os.path.join(folder, "index.html"), "w", encoding="utf-8") as f:
        f.write(index_page(day, rows, failed, label))
    with open(os.path.join(folder, "summary.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["批次日期", "代號", "名稱", "群組", "股價日期", "收盤", "漲跌幅%", "量比", "法人近5日(張)",
                    "法人近20日(張)", "相對大盤20日(百分點)", "趨勢分", "動能分", "籌碼分", "量價分", "綜合分", "規則研判", "資料來源", "布林帶寬%", "布林%B", "帶寬百分位", "布林狀態", "資料狀態", "ADX14", "＋DI14", "−DI14", "量價方向", "成交活躍度", "計分版本"])
        for r in rows:
            d = r["data"]
            rs = ((d.get("bench") or {}).get("d20") or {}).get("rs")
            sc = d["scores"]
            bb = d.get("bollinger") or {}
            w.writerow([C.csv_cell(v) for v in [day, d["code"], d["name"], "、".join(r["groups"]), d["last_date"], d["quote"]["close"],
                        d["quote"]["chg_pct"], d["quote"]["vratio"], d["chip"]["net5"], d["chip"]["net20"], rs,
                        sc["trend"], sc["momentum"], sc["chip"], sc["volume"], sc["overall"],
                        d["plan"]["verdict"], d["source"], bb.get("width"), bb.get("percent_b"), bb.get("width_rank"),
                        C.bollinger_label(bb), " · ".join(C.notes(d)) or "資料齊全",
                        d["dmi"]["adx"], d["dmi"]["plus_di"], d["dmi"]["minus_di"], d["volume_analysis"]["state"],
                        d["volume_analysis"]["activity"], d["score_model"]]])

    if a.keep > 0:
        dated = sorted(x for x in os.listdir(a.out)
                       if re.fullmatch(r"\d{4}-\d{2}-\d{2}", x) and os.path.isdir(os.path.join(a.out, x)))
        for old in dated[:-a.keep]:
            shutil.rmtree(os.path.join(a.out, old), ignore_errors=True)

    T.log("完成 %d 檔、失敗 %d 檔。總覽：%s" % (len(rows), len(failed), os.path.join(folder, "index.html")))
    return 0 if rows else 1


if __name__ == "__main__":
    sys.exit(main())
