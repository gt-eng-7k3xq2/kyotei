@echo off
rem 2026-09-15 receipt-audit review package convenience runner.
rem Runs every race-ops related regression test in sequence from this file's own directory.
rem Usage: double-click, or run from a terminal: run_all_race_ops_tests.cmd
setlocal enabledelayedexpansion
cd /d "%~dp0.."
set FAIL=0

for %%F in (
  tests\realtime_event_store.regression.test.js
  tests\race_ops_event_store.regression.test.js
  tests\race_ops_analysis.regression.test.js
  tests\race_ops_server.regression.test.js
  tests\race_ops_server_startup.regression.test.js
  tests\race_ops_result_updater.regression.test.js
  tests\race_ops_task_isolation.regression.test.js
  tests\race_ops_jst_time.regression.test.js
) do (
  echo ============================================================
  echo RUNNING %%F
  echo ============================================================
  node "%%F"
  if errorlevel 1 (
    echo FAILED: %%F
    set FAIL=1
  )
)

echo ============================================================
if "%FAIL%"=="1" (
  echo RESULT: ONE OR MORE TEST FILES FAILED
  exit /b 1
) else (
  echo RESULT: ALL TEST FILES PASSED
  exit /b 0
)
