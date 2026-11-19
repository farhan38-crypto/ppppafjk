@echo off
rem ROYAL TRADING COMPANY - starts the admin app (this PC only) and the customer catalogue (your Wi-Fi)
cd /d "%~dp0"
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
start "RTC customer catalogue :8080" .venv\Scripts\python catalog_app.py
.venv\Scripts\python app.py
