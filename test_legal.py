# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
"""公開發布前的檢查：授權檔、檔頭、介面法律聲明、個資外流。"""
import os
import re
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

_tmp = tempfile.TemporaryDirectory()
os.environ.setdefault("TWBOARD_CACHE_DIR", str(Path(_tmp.name) / "cache"))

import twboard as T           # noqa: E402
import twserve as S           # noqa: E402

ROOT = Path(__file__).resolve().parent
SOURCE = [p for p in ROOT.iterdir() if p.is_file() and p.suffix in (".py", ".js", ".css", ".html", ".bat")
          and p.name != "echarts.min.js"]
PUBLIC = [p for p in ROOT.iterdir() if p.is_file() and p.name not in
          ("echarts.min.js", "watchlists.json", "filter_presets.json", "test_local.json")]


class LegalTests(unittest.TestCase):
    def test_license_files_present(self):
        self.assertTrue((ROOT / "LICENSE").read_text(encoding="utf-8").lstrip().startswith("GNU GENERAL PUBLIC LICENSE"))
        self.assertIn("Version 3, 29 June 2007", (ROOT / "LICENSE").read_text(encoding="utf-8")[:200])
        self.assertIn("section 7", (ROOT / "LICENSE-EXCEPTION.md").read_text(encoding="utf-8"))
        self.assertIn("Apache License", (ROOT / "licenses" / "ECharts-LICENSE.txt").read_text(encoding="utf-8")[:400])
        self.assertIn("Apache ECharts", (ROOT / "licenses" / "ECharts-NOTICE.txt").read_text(encoding="utf-8"))
        self.assertIn("Licensed to the Apache Software Foundation", (ROOT / "echarts.min.js").read_text(encoding="utf-8")[:300])

    def test_every_source_file_has_spdx_and_copyright(self):
        self.assertGreater(len(SOURCE), 25)
        for p in SOURCE:
            head = p.read_text(encoding="utf-8")[:700]
            self.assertIn("SPDX-License-Identifier: GPL-3.0-only", head, p.name)
            self.assertIn("Copyright (C) 2026", head, p.name)

    def test_batch_files_have_ascii_only_before_codepage_switch(self):
        # chcp 65001 之前的行是用系統字碼頁讀的，混入中文位元組可能吃掉換行。
        for p in ROOT.glob("*.bat"):
            before = p.read_bytes().split(b"chcp 65001")[0]
            self.assertTrue(all(b < 128 for b in before), p.name)

    def test_no_personal_paths_or_secrets_in_public_files(self):
        pattern = re.compile(r"C:[/\\\\]Users[/\\\\]|/home/[a-z]+/|AppData[/\\\\]|codex-runtimes", re.I)
        for p in PUBLIC:
            if p.name == Path(__file__).name:
                continue
            self.assertIsNone(pattern.search(p.read_text(encoding="utf-8", errors="ignore")), p.name)

    def test_gitignore_excludes_data_and_personal_settings(self):
        rules = (ROOT / ".gitignore").read_text(encoding="utf-8").split()
        for needed in (".twboard-cache/", "reports/", "qa-*/", "watchlists.json", "filter_presets.json", "test_local.json"):
            self.assertIn(needed, rules)

    def test_pages_show_legal_notice(self):
        app = T.assemble(T._part("board_app.html"), "")
        self.assertIn('class="legal"', app)
        self.assertIn("不附任何擔保", app)
        self.assertIn('href="/LICENSE"', app)
        report = T.render(T.analyse("X", T.fetch_demo("X"), 30), "")
        self.assertIn('class="legal"', report)
        self.assertIn("額外許可", report)
        self.assertNotIn('href="/LICENSE"', report, "匯出檔沒有伺服器，不能放本機連結")
        self.assertIn("SPDX-License-Identifier: GPL-3.0-only", report, "內嵌的程式碼要帶著授權標記")

    def test_source_url_is_escaped_and_shown_when_set(self):
        old = T.APP_SOURCE_URL
        try:
            T.APP_SOURCE_URL = 'https://example.org/x?a=1&b="2"'
            html = T.legal_html(exported=True)
            self.assertIn("https://example.org/x?a=1&amp;b=&quot;2&quot;", html)
            self.assertIn("原始碼", T.legal_text())
        finally:
            T.APP_SOURCE_URL = old

    def test_server_serves_license_texts_locally(self):
        server = S.ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = "http://127.0.0.1:%d" % server.server_address[1]
            for path, marker in (("/LICENSE", "GNU GENERAL PUBLIC LICENSE"), ("/LICENSE-EXCEPTION", "Additional permission"),
                                 ("/THIRD-PARTY-NOTICES", "Apache ECharts")):
                with urllib.request.urlopen(base + path, timeout=10) as r:
                    self.assertEqual(r.status, 200)
                    self.assertIn(marker, r.read().decode("utf-8"))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
