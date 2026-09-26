# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
"""20260925b 連線問題：Python 3.13 X.509 嚴格模式、錯誤原因、連不上時不洗版、連線檢查。"""
import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("TWBOARD_CACHE_DIR", tempfile.mkdtemp(prefix="twboard-conn-"))
os.environ["TWBOARD_DATA_DIR"] = tempfile.mkdtemp(prefix="twboard-conn-data-")
import twboard as T           # noqa: E402
import twcache as C           # noqa: E402
import twmarket as MK         # noqa: E402
import twserve as S           # noqa: E402

MK.INTERVAL = {}

CA_CNF = """[req]
distinguished_name=dn
prompt=no
x509_extensions=v3_ca
[dn]
CN=Test CA without key identifiers
[v3_ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=none
authorityKeyIdentifier=none
"""
LEAF_CNF = """[ext]
basicConstraints=CA:FALSE
subjectAltName=DNS:localhost,IP:127.0.0.1
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=none
authorityKeyIdentifier=none
"""


def make_certs():
    """做一組「缺少 Subject/Authority Key Identifier」的憑證，模擬證交所、櫃買的狀況。"""
    if not shutil.which("openssl"):
        return None
    d = Path(tempfile.mkdtemp(prefix="twboard-cert-"))
    (d / "ca.cnf").write_text(CA_CNF); (d / "leaf.cnf").write_text(LEAF_CNF)
    run = lambda *a: subprocess.run(a, cwd=d, check=True, capture_output=True)
    try:
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "5", "-config", "ca.cnf")
        run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost")
        run("openssl", "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
            "-out", "leaf.pem", "-days", "5", "-extfile", "leaf.cnf", "-extensions", "ext")
    except (subprocess.CalledProcessError, OSError):
        return None
    return d


class JSONHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"stat": "OK", "hello": "世界"}).encode("utf-8")
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


@unittest.skipUnless(hasattr(ssl, "VERIFY_X509_STRICT"), "這個 Python 沒有 X.509 嚴格模式")
class StrictModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.certs = make_certs()
        if not cls.certs:
            raise unittest.SkipTest("沒有 openssl，無法產生測試憑證")
        srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        srv_ctx.load_cert_chain(str(cls.certs / "leaf.pem"), str(cls.certs / "leaf.key"))
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), JSONHandler)
        cls.httpd.socket = srv_ctx.wrap_socket(cls.httpd.socket, server_side=True)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = "https://localhost:%d/x" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close()

    def ctx(self, strict):
        c = T._ssl_context()
        c.load_verify_locations(str(self.certs / "ca.pem"))
        if strict:
            c.verify_flags |= ssl.VERIFY_X509_STRICT          # Python 3.13 起的預設
        return c

    def test_strict_mode_rejects_but_our_context_accepts(self):
        with self.assertRaises(urllib.error.URLError) as e:
            urllib.request.urlopen(self.url, timeout=10, context=self.ctx(True))
        self.assertIn("Key Identifier", T.describe_error(e.exception), "嚴格模式會因為缺少 Key Identifier 而拒絕")
        with urllib.request.urlopen(self.url, timeout=10, context=self.ctx(False)) as r:
            self.assertEqual(json.loads(r.read())["hello"], "世界")
        self.assertFalse(T._SSL_CTX.verify_flags & ssl.VERIFY_X509_STRICT)
        self.assertEqual(T._SSL_CTX.verify_mode, ssl.CERT_REQUIRED, "仍然要驗證憑證")
        self.assertTrue(T._SSL_CTX.check_hostname, "仍然要比對主機名稱")

    def test_untrusted_certificate_is_still_rejected(self):
        with self.assertRaises(urllib.error.URLError) as e:
            urllib.request.urlopen(self.url, timeout=10, context=T._ssl_context())      # 沒有信任這個測試 CA
        self.assertIn("SSL 憑證驗證失敗", T.describe_error(e.exception))

    def test_http_get_json_end_to_end(self):
        with patch.object(T, "_SSL_CTX", self.ctx(False)), C.operation() as st:
            self.assertEqual(T.http_get_json(self.url)["hello"], "世界")
        self.assertEqual(st["warnings"], [])
        with patch.object(T, "_SSL_CTX", self.ctx(True)), C.operation() as st:
            self.assertIsNone(T.http_get_json(self.url))
        self.assertTrue(any("SSL 憑證驗證失敗" in w and "Key Identifier" in w for w in st["warnings"]), st["warnings"])
        self.assertIn("localhost", "".join(st["errors"]))


class DescribeErrorTests(unittest.TestCase):
    def test_messages(self):
        cases = [(urllib.error.URLError(socket.gaierror(11001, "getaddrinfo failed")), "找不到主機"),
                 (urllib.error.URLError(ConnectionRefusedError()), "連線被拒絕"),
                 (urllib.error.URLError(ConnectionResetError()), "連線被中斷"),
                 (urllib.error.URLError(TimeoutError()), "連線逾時"),
                 (urllib.error.URLError(OSError("Tunnel connection failed: 407 Proxy Authentication Required")), "代理伺服器"),
                 (urllib.error.HTTPError("http://x", 403, "Forbidden", {}, None), "HTTP 403")]
        for err, want in cases:
            self.assertIn(want, T.describe_error(err))


class MarketOfflineTests(unittest.TestCase):
    def setUp(self):
        C.CACHE_DIR = Path(tempfile.mkdtemp(prefix="twboard-conn-"))
        os.environ["TWBOARD_DATA_DIR"] = tempfile.mkdtemp(prefix="twboard-conn-data-")
        MK._tpex_pref.update(quotes=0, insti=0)

    def ssl_fail(self, req, timeout=None, context=None):
        host = urllib.parse.urlsplit(req.full_url if hasattr(req, "full_url") else req).netloc
        if "twse" in host or "tpex" in host:
            e = ssl.SSLCertVerificationError(1, "certificate verify failed")
            e.verify_message = "Missing Subject Key Identifier"
            raise urllib.error.URLError(e)
        raise urllib.error.URLError(socket.gaierror(11001, "getaddrinfo failed"))

    def test_scan_fails_fast_with_reason_and_no_warning_flood(self):
        calls = []
        def urlopen(req, timeout=None, context=None):
            calls.append(req.full_url)
            return self.ssl_fail(req)
        t = time.time()
        with patch.object(T.urllib.request, "urlopen", side_effect=urlopen), C.operation() as st:
            raw = MK.collect(61)
        self.assertIsNone(raw)
        self.assertLess(time.time() - t, 5, "連不上時要很快結束，不要每一天都等")
        self.assertLessEqual(len([c for c in calls if "twse" in c]), 1, "證交所失敗一次後，這次掃描就不再試")
        self.assertLessEqual(len(st["warnings"]), 4, st["warnings"])
        self.assertTrue(any("Missing Subject Key Identifier" in w for w in st["warnings"]))
        log = Path(MK.data_path("market_debug.log")).read_text(encoding="utf-8")
        self.assertIn("Missing Subject Key Identifier", log)

    def test_scan_job_error_mentions_reason_and_diagnose(self):
        S.DEMO_MODE = False
        S._market.update(raw=None, results={}, job=None, by={})
        with patch.object(T.urllib.request, "urlopen", side_effect=self.ssl_fail):
            job = S.start_market_scan({"days": ["20"]})
            for _ in range(200):
                j = S.job_status(job)
                if j["status"] in ("done", "error"):
                    break
                time.sleep(0.02)
        self.assertEqual(j["status"], "error")
        self.assertIn("Missing Subject Key Identifier", j["error"]); self.assertIn("連線檢查", j["error"])

    def test_diagnose_reports_each_source(self):
        class Resp:
            status = 200
            def __init__(self, body): self.body = body.encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return self.body
        def urlopen(req, timeout=None, context=None):
            u = req.full_url
            if "finmind" in u:
                return Resp(json.dumps({"status": 200, "data": []}))
            if "dailyQuotes" in u:
                return Resp("<html>維護中</html>")
            if "stk_quote_result" in u:
                return Resp(json.dumps({"aaData": [["6488", "環球晶", "500", "+1", "499", "501", "498", "500", "1,000", "500,000", "10"]]}))
            return self.ssl_fail(req)
        with patch.object(T.urllib.request, "urlopen", side_effect=urlopen):
            d = MK.diagnose()
        by = {c["source"]: c for c in d["checks"]}
        self.assertEqual(len(d["checks"]), 7)
        self.assertFalse(by["證交所 上市行情"]["ok"]); self.assertIn("Missing Subject Key Identifier", by["證交所 上市行情"]["result"])
        self.assertTrue(by["FinMind"]["ok"])
        self.assertFalse(by["櫃買 上櫃行情（新版網址）"]["ok"]); self.assertIn("不是 JSON", by["櫃買 上櫃行情（新版網址）"]["result"])
        self.assertIn("維護中", by["櫃買 上櫃行情（新版網址）"]["head"])
        self.assertTrue(by["櫃買 上櫃行情（舊版網址）"]["ok"]); self.assertIn("1 筆", by["櫃買 上櫃行情（舊版網址）"]["result"])
        self.assertTrue(d["python"] and d["openssl"])
        if hasattr(ssl, "VERIFY_X509_STRICT"):
            self.assertTrue(d["x509_strict_off"])


if __name__ == "__main__":
    unittest.main()
