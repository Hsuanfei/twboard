@echo off
rem SPDX-License-Identifier: GPL-3.0-only
rem Copyright (C) 2026 Mick Huang. Free software under GNU GPL v3, NO WARRANTY. See LICENSE.
chcp 65001 >nul
title 台股戰略產生器1002a版
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (set "PY=py -3") else (set "PY=python")
%PY% -B twserve.py %*
if errorlevel 1 (
  echo.
  echo 啟動失敗。請確認已安裝 Python 3.10 以上，並且安裝時有勾選 "Add python.exe to PATH"。
  pause
)
