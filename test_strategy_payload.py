# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 黃炫斐 (Mick Huang)
# 本檔案是「台股戰略產生器」的一部分：自由軟體，依 GNU GPL 第 3 版釋出，不附任何擔保，詳見 LICENSE。
# 匯出的報告另有額外許可，見 LICENSE-EXCEPTION.md。
import json
import unittest
from copy import deepcopy
import twboard as T
import twserve as S

class StrategyPayloadTests(unittest.TestCase):
    def test_historical_payload_matches_that_day_and_window_independent(self):
        raw=T.fetch_demo("TEST",days=200,seed=7)
        whole=T.analyse("TEST",raw,120)
        self.assertEqual(whole["strategy_input"],T.analyse("TEST",raw,30)["strategy_input"])
        history=whole["strategy_input"]["bars"]
        for offset in (60,90,199):
            partial=dict(raw,bars=raw["bars"][:offset+1])
            then=T.analyse("TEST",partial,30)
            self.assertAlmostEqual(round(history[offset-60]["score"],1),then["scores"]["overall"])
            self.assertEqual(history[offset-60]["bb_break_up"],then["bollinger"]["break_up"])
    def test_all_event_dates_and_status_preserved(self):
        raw=T.fetch_demo("TEST",days=200,seed=7)
        raw["dividends"]=[{"date":raw["bars"][70]["date"],"kind":"除息","amount":1}]
        p=T.analyse("TEST",raw,30)
        self.assertEqual(p["dividends"]["recent"],[])
        self.assertEqual(p["strategy_input"]["events"],[raw["bars"][70]["date"]])
        self.assertTrue(p["strategy_input"]["events_confirmed"])
        raw["dividend_status"]="partial"
        self.assertFalse(T.analyse("TEST",raw,30)["strategy_input"]["events_confirmed"])
    def test_export_options_validation(self):
        good={"signal":"both","hold":10,"fee":0.05,"tax":0.1,"slip":0.2,"threshold":72,"require_chip":True,"segment":"late","start":"2026-01-01","end":"2026-09-01"}
        self.assertEqual(S.export_strategy({"strategy":[json.dumps(good)]}),good)
        for bad in ({"fee":float("nan")},{"fee":float("inf")},{"fee":True},{"hold":2.5},{"tax":-1},{"require_chip":"false"},{"x":"y"},{"signal":"<script>"},{"segment":"other"},{"start":"bad"},{"start":"2026-09-01","end":"2026-01-01"},[]):
            with self.assertRaises(ValueError):S.export_strategy({"strategy":[json.dumps(bad)]})
    def test_report_contains_engine_and_snapshot_settings(self):
        payload=T.analyse("TEST",T.fetch_demo("TEST",days=160,seed=7),30)
        copy=deepcopy(payload);copy["strategy_settings"]={"hold":10,"fee":0.1}
        html=T.render(copy,"")
        self.assertIn('TWStrategy',html)
        self.assertIn('"strategy_settings": {"hold": 10, "fee": 0.1}',html)
        self.assertNotIn("strategy_settings",payload)

if __name__=="__main__":unittest.main()
