# nickwick-replay

A replay of the futures market that looks and works like TradingView, on the data of the
[Rithmic Bridge](https://github.com/) (nickwick-rithmic-bridge): its archive of 1-minute bars with the volume per
price, its 1-second bars, its tick export, and its live feed. Candles of any timeframe, volume profile, market profile
(TPO), VWAP with bands, footprint, drawing tools, simulated orders - everything cut at one replay clock.

## Start

Double-click `Nick.cmd`. The first start makes a `.venv` in this folder and installs numpy and pandas into it
(Python 3.11+ from python.org, "Add python.exe to PATH" ticked), then opens `http://127.0.0.1:8021/`. Without a
`replay.cfg` the settings page opens first: enter the bridge's archive folder (the one with `1m-bars` and `1s-bars`
in it) and save. A `trainer.cfg` of the older tool next to it is read once for that folder.

The console window is the server; leave it open. By hand: `.venv\Scripts\python server\main.py`.

## In the home network (iPad, phone, another PC)

Settings page → Server → "Im Heimnetz erreichbar" on, save, restart the server. It then listens on every address of
the machine and prints its home-network addresses at start, e.g. `http://192.168.1.20:8021/`; open that on the
iPad. Windows asks once to allow Python through the firewall (private networks). The page adapts to the screen
(`web/tv/mobile.css`): on an iPad the side bars shrink, on a phone the drawing bar steps back. POSTs still need the
page's token, and the Host a request names must be an IP address of the machine or its name - a DNS name of
someone else is refused.

## What it is

- `web/` the page: one to four charts on one clock, each with its own timeframe, chart type (candles, hollow, bars,
  Heikin Ashi, line, area, footprint, TPO) and indicators; the replay bar; the drawing tools; the order ticket and the
  trading panel; the settings page. Several browser windows (one per monitor) share the clock.
- `server/` one process:
  - `archive.py` reads the bridge's archive into arrays and checks a day's files for what does not add up
  - `session.py` New York time, CME sessions (18:00 the evening before to 17:00), regular hours, buckets
  - `timeline.py` bars of any timeframe, the volume per price of every bar, the profile of a range - cut at the clock
  - `profile.py` per session: RTH and overnight volume profile, TPO, initial balance, VWAP bands, naked POCs
  - `broker.py` the simulated broker: orders filled against the day's prints (tick export, else a path through the
    1-second bars; live the bridge's prints), the account a pure function of the actions and the clock
  - `clock.py` the replay clock, `live.py` the bridge's live data, `main.py` the HTTP server, `settings.py` replay.cfg

## The rules of the data

- A whole minute shown is its minute file's row: exact volume per price with the aggressor side. Only the minute the
  clock stands in is built up to the clock and marked forming: from the bridge's prints when it sends them (today's
  session, exact print by print), else from the 1-second bars (o h l c, volume, buyers, sellers exact; the levels
  spread over each second's range).
- A minute the minute file lacks although the 1-second file has it is built from the seconds and marked approx.
- Bars of seconds (5 s, 15 s, 30 s) come from the bridge's prints where they exist, else from the 1-second bars with
  the levels spread (marked approx). Minutes and up come from the minute files.
- Nothing after the clock exists: bars, profiles, levels, the account.
- Fills: a market order takes the next print on its side, a resting limit fills when a print trades through it, a
  stop at the print that crossed it. Without a tick export the prints are a path through each second (open, low,
  high, close or open, high, low, close by the second's direction): an assumption, the panel says so.
- The settings page checks any day's files: levels against the minute's volume, gaps, the seconds against the minutes.
- Profiles (session, visible range, fixed range) carry the exact volume (and delta on request) on every row as soon
  as the rows are 9 px tall; the legend names the row size. For checking against another tool, row by row.

## Tests

`.venv\Scripts\python -m pip install -r tests\requirements.txt`, then `.venv\Scripts\python -m pytest tests`.
`tests/data` holds a real archive day (ES, 2026-10-12). `tests/reference.py` recomputes bars, levels, profiles and the
VWAP straight from the files with the csv module and no code in common with the server; the tests compare the server's
answers to it number by number, the broker's rules on a hand-made tape and the path through the real seconds, and the
routes, the token, live ingest and paper trading through the HTTP server.

## Routes

`GET /` the page · `/config.html` settings · `/tl/sessions?inst` · `/tl/bars?inst&tf&from&to&until` ·
`/tl/levels?inst&tf&from&to&until` (per bar `[price, volume, buy, sell]`) · `/tl/profile?inst&from&to&until` ·
`/tl/amt?inst&from&to&until[&row][&naked][&eth]` · `/feeds` · `/health` · `POST /ingest` (the bridge) ·
`/api/clock`, `/api/clock/stream`, `/api/broker/*`, `/api/config`, `/api/inventory`, `/api/check`, `/api/status`,
`/api/screenshot` (every POST needs the page's token).

## Tools

`tools/bridge_capture.py` records what the Rithmic Bridge sends (listen on 8022, forward to 8021, log next to the script) - for checking the bridge\x27s messages against what the server expects.
