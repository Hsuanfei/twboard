# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
import copy
import csv
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import twcompare as C
import twboard as T
import twbatch as B


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "filter_presets.json"
        self.env = patch.dict(os.environ, TWBOARD_FILTER_FILE=str(self.path))
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_roundtrip_update_delete_and_corruption_keeps_original(self):
        f = dict(query=" 台積 ", bb="break_up", score=0, rs=True, chip=False)
        self.assertEqual(C.load_presets(), {})
        saved = C.update_preset(" 波段 ", f)
        self.assertEqual(saved["波段"]["score"], 0)
        self.assertEqual(saved["波段"]["query"], "台積")
        self.assertEqual(C.load_presets(), saved)
        self.assertEqual(C.update_preset("波段", {})["波段"]["score"], None)
        self.assertEqual(C.update_preset("波段", delete=True), {})
        self.path.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "原檔未覆寫"):
            C.update_preset("new", {})
        self.assertEqual(self.path.read_text(), "{broken")
        self.assertEqual(len(list(self.path.parent.iterdir())), 1)

    def test_invalid_filters_never_write(self):
        for f in ([], {"extra": 1}, {"score": True}, {"score": float("nan")},
                  {"score": float("inf")}, {"score": -1}, {"score": 101}, {"score": "20"},
                  {"rs": "false"}, {"chip": 1}, {"bb": []}, {"bb": "typo"}, {"query": "x"*101}):
            with self.subTest(filters=f), self.assertRaises(ValueError):
                C.update_preset("sample", f)
        for name in ("", "x"*31, "line\nbreak"):
            with self.assertRaises(ValueError):
                C.update_preset(name, {})
        self.assertFalse(self.path.exists())

    def test_limit_existing_update_and_failed_replace(self):
        self.path.write_text(json.dumps({str(i): C.normalize({}) for i in range(50)}))
        with self.assertRaises(ValueError): C.update_preset("new", {})
        C.update_preset("0", {"score": 72})
        before = self.path.read_bytes()
        with patch.object(C.os, "replace", side_effect=OSError("locked")):
            with self.assertRaises(OSError): C.update_preset("0", {})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(list(self.path.parent.iterdir())), 1)

    def test_shared_quality_and_bollinger_batch_output(self):
        d = T.analyse("TEST", T.fetch_demo("TEST", days=200, seed=5), 30)
        d["fetch_info"] = {"warnings": ["x"]}
        d["avail"].update(margin=True, margin_current=False, margin_latest=d["last_date"], indicators_ready=False)
        d["chip"]["coverage20"] = 19
        d["dividends"] = {"available": False, "recent": [{"date": d["last_date"]}]}
        d["bench"] = None
        d["bollinger"] = {"upper": 100, "percent_b": 1.2, "width": 4.5, "width_rank": None, "break_up": True}
        expected = ["法人 19/20 日", "融資券欄位缺漏", "指標筆數不足", "更新有缺漏", "除權息未完整取得", "大盤基準不足", "近60日有除權息"]
        self.assertEqual(C.notes(d), expected)
        html = B.index_page("2026-09-20", [{"data": d, "groups": [], "file": "test.html"}], [], "test")
        for note in expected + ["今日突破上軌", "收斂歷史不足", "布林%B", "4.50%", "1.200"]:
            self.assertIn(note, html)
        self.assertEqual(C.bollinger_label(None), "資料不足")
        self.assertEqual(C.bollinger_label({"upper": 100, "width": 0, "percent_b": None, "width_rank": 50}), "零寬度")

    def test_csv_text_formulas_escaped_but_numbers_kept(self):
        for text in ("=1+1", " +cmd", "-formula", "@test"):
            self.assertEqual(C.csv_cell(text), "'"+text)
        self.assertEqual(C.csv_cell(-100), -100)
        self.assertEqual(C.csv_cell("0050"), "0050")


if __name__ == "__main__":
    unittest.main()
