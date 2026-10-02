# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import twcache as C
import twboard as T
import twserve as S


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(C.close_cache)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for name,value in [("CACHE_DIR",Path(self.temp.name)),("today",lambda:dt.date(2026,9,19))]:
            p=patch.object(C,name,value);p.start();self.addCleanup(p.stop)
        self.addCleanup(C.close_cache)

    def fetch(self,start,end):
        return [{"date":d,"value":int(d[-2:])} for d in C.dates(start,end)]

    def test_repeat_and_extended_range_only_requests_missing_days(self):
        calls=[]
        def fetch(start,end):
            calls.append((start,end));return self.fetch(start,end)
        with C.operation():
            first=C.range_data("key","2026-01-10","2026-01-20",fetch)
            self.assertEqual(len(first),11)
            C.range_data("key","2026-01-10","2026-01-20",fetch)
            final=C.range_data("key","2026-01-05","2026-01-25",fetch)
        self.assertEqual(calls,[("2026-01-10","2026-01-20"),("2026-01-05","2026-01-09"),("2026-01-21","2026-01-25")])
        self.assertEqual(len(final),21)
        self.assertEqual(len({r["date"] for r in final}),21)

    def test_cache_survives_a_new_process(self):
        C.range_data("restart","2026-01-01","2026-01-02",self.fetch)
        env=dict(os.environ,TWBOARD_CACHE_DIR=self.temp.name)
        code="import twcache as c; rows=c.range_data('restart','2026-01-01','2026-01-02',lambda *a: (_ for _ in ()).throw(AssertionError('network'))); assert len(rows)==2; print('disk cache OK')"
        run=subprocess.run([sys.executable,"-B","-c",code],cwd=str(Path(__file__).parent),env=env,capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertIn("disk cache OK",run.stdout)

    def test_refresh_only_recent_days_and_replace_revised_rows(self):
        C.range_data("recent","2026-09-01","2026-09-19",self.fetch)
        with C.database() as db: db.execute("UPDATE cache SET fetched=0")
        calls=[]
        def revised(a,b):
            calls.append((a,b));return [{"date":d,"value":99} for d in C.dates(a,b)]
        data=C.range_data("recent","2026-09-01","2026-09-19",revised)
        self.assertEqual(calls,[("2026-09-12","2026-09-19")])
        self.assertEqual(data[0]["value"],1)
        self.assertEqual(data[-1]["value"],99)
        self.assertEqual(len(data),19)

    def test_failure_preserves_old_values_and_retries_gap(self):
        C.range_data("failure","2026-09-17","2026-09-18",self.fetch)
        with C.database() as db: db.execute("UPDATE cache SET fetched=0")
        with C.operation() as state:
            old=C.range_data("failure","2026-09-17","2026-09-19",lambda a,b:None)
            self.assertEqual(len(old),2)
            self.assertTrue(state["warnings"])
        self.assertNotIn("2026-09-19",C.read("failure"))
        calls=[]
        def repaired(a,b):calls.append((a,b));return self.fetch(a,b)
        self.assertEqual(len(C.range_data("failure","2026-09-17","2026-09-19",repaired)),3)
        self.assertEqual(calls,[("2026-09-17","2026-09-19")])

    def test_successful_empty_days_do_not_repeat_requests(self):
        calls=[]
        def empty(a,b):calls.append(1);return []
        C.range_data("holiday","2026-01-01","2026-01-02",empty)
        self.assertEqual(C.range_data("holiday","2026-01-01","2026-01-02",empty),[])
        self.assertEqual(len(calls),1)

    def test_empty_refresh_does_not_erase_known_rows(self):
        C.range_data("known","2026-09-18","2026-09-19",self.fetch)
        with C.database() as db: db.execute("UPDATE cache SET fetched=0")
        with C.operation() as state:
            result=C.range_data("known","2026-09-18","2026-09-19",lambda a,b:[])
            self.assertEqual(len(result),2)
            self.assertTrue(state["warnings"])
        self.assertEqual(C.read("known")["2026-09-18"][1],0)

    def test_known_trading_day_missing_chips_is_retried(self):
        C.range_data("missing-chip","2026-01-05","2026-01-05",lambda a,b:[])
        with C.database() as db: db.execute("UPDATE cache SET fetched=0")
        result=C.range_data("missing-chip","2026-01-05","2026-01-05",self.fetch,required_dates=["2026-01-05"])
        self.assertEqual(len(result),1)

    def test_namespace_and_no_plain_token_on_disk(self):
        a=C.key_for("finmind","https://a.example","price","2330","unit-test-token")
        b=C.key_for("finmind","https://b.example","price","2330","unit-test-token")
        c=C.key_for("finmind","https://a.example","price","2330","other-token")
        self.assertEqual(len({a,b,c}),3)
        C.range_data(a,"2026-01-01","2026-01-02",self.fetch)
        self.assertEqual(C.read(b),{})
        self.assertNotIn(b"unit-test-token",(Path(self.temp.name)/"market.sqlite3").read_bytes())

    def test_corrupt_database_falls_back_without_blocking_data(self):
        (Path(self.temp.name)/"market.sqlite3").write_bytes(b"invalid database")
        with C.operation() as state:
            data=C.range_data("key","2026-01-01","2026-01-02",self.fetch)
            self.assertEqual(len(data),2)
            self.assertTrue(state["warnings"])

    def test_twse_market_responses_are_shared_between_stocks(self):
        calls=[]
        def get(url,params):
            calls.append((url,params))
            if url==T.TWSE_DAY:
                return {"stat":"OK","data":[["115/09/10","1000000","10000000","10","11","9","10","0","100"]]}
            if url==T.TWSE_T86:
                return {"stat":"OK","data":[[code,"Name",0,0,1000,0,0,0,0,0,2000,6000] for code in ("2330","2317")]}
            return {"stat":"OK","data":[[code,"Name",0,0,0,100,110,999,0,0,0,10,12,999] for code in ("2330","2317")]}
        with patch.object(T,"http_get_json",side_effect=get),C.operation():
            first=T.fetch_twse("2330","2026-09-10","2026-09-10",throttle=0)
            second=T.fetch_twse("2317","2026-09-10","2026-09-10",throttle=0)
        self.assertEqual(len(calls),4)
        self.assertEqual(first["chips"],second["chips"])
        self.assertEqual(second["margin"]["2026-09-10"]["margin_bal"],110)

    def test_progress_stages_and_counters(self):
        events=[]
        with C.operation(events.append):
            C.report("股價","開始")
            C.range_data("progress","2026-01-01","2026-01-02",self.fetch)
            C.report("三大法人","開始")
        self.assertTrue(any(e["stage"]=="股價" for e in events))
        self.assertEqual(events[-1]["stage"],"三大法人")
        self.assertEqual(events[-1]["network_requests"],1)
        self.assertEqual(events[-1]["downloaded_days"],2)
        self.assertNotIn("callback",events[-1])

    def test_failed_response_not_cached(self):
        calls=[]
        def bad():calls.append(1);return {"stat":"ERROR"}
        for _ in range(2):C.response("bad",bad,lambda j:j and j.get("stat")=="OK",600)
        self.assertEqual(len(calls),2)
        self.assertEqual(C.read("bad"),{})


class JobTests(unittest.TestCase):
    def test_demo_does_not_claim_persistent_cache(self):
        d=S.get_payload({"code":["DEMO"],"source":["demo"],"days":["30"]})
        self.assertEqual(d["fetch_info"]["mode"],"demo")
        self.assertEqual(d["fetch_info"]["network_requests"],0)
        S._cache.clear()

    def test_job_reports_stage_and_preserves_snapshot(self):
        import threading
        started,release=threading.Event(),threading.Event()
        def fetch(*args,**kwargs):
            C.report("三大法人","離線測試階段")
            started.set();release.wait(3)
            return T.fetch_demo("JOB",days=180,seed=7)
        S._cache.clear()
        with patch.object(T,"fetch_raw",side_effect=fetch):
            ident=S.start_job({"code":["JOB"],"days":["30"]})
            self.assertTrue(started.wait(2))
            job=S.job_status(ident)
            self.assertEqual(job["status"],"running")
            self.assertEqual(job["stage"],"三大法人")
            release.set()
            for _ in range(100):
                job=S.job_status(ident)
                if job["status"]=="done":break
                time.sleep(.02)
            self.assertEqual(job["status"],"done")
            snapshot=S.get_snapshot({"snapshot":[job["data"]["snapshot_id"]]})
            self.assertEqual(snapshot["bars_count"],30)
        S._cache.clear();S._jobs.clear()

    def test_failed_job_contains_no_secret(self):
        with patch.object(S,"get_payload",side_effect=RuntimeError("secret-value")):
            ident=S.start_job({"code":["BAD"]})
            for _ in range(100):
                job=S.job_status(ident)
                if job["status"]=="error":break
                time.sleep(.02)
            self.assertEqual(job["status"],"error")
            self.assertNotIn("secret-value",json.dumps(job))
        S._jobs.clear()


if __name__=="__main__":unittest.main()
