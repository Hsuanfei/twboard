@echo off
rem SPDX-License-Identifier: GPL-3.0-only
rem Copyright (C) 2026 Mick Huang. Free software under GNU GPL v3, NO WARRANTY. See LICENSE.
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (set "PY=py -3") else (set "PY=python")
if not exist reports mkdir reports
rem 跑 watchlists.json 裡的全部群組，只保留最近 60 個日期資料夾；過程記錄在 reports\batch.log
%PY% -B twbatch.py --keep 60 %* >> reports\batch.log 2>&1
