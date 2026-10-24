# STATE - where nickwick-replay stands (23 Oct 2026)

A rebuild from scratch, after the older trainer had grown into a mix of heatmap, trainer, workspace and the
TradingView-like page with tests bent around it. Nothing of the older server was taken over unread; the fill rules of
the broker and the clock were taken over after reading them line by line, everything else is new. No heatmap, no
Databento, no MBO: the data are the Rithmic Bridge's archive and its live feed, nothing else.

## What holds

- Every number the page shows comes out of the bridge's files and is checked against `tests/reference.py` on the
  user's real day 2026-10-12 (ES): bars of every timeframe, the volume per price of every bar, RTH and overnight
  profiles (POC, VAH, VAL, delta per price), TPO counts over 13 periods, initial balance, VWAP and its standard
  deviation, the cut at the clock at three moments, the forming minute from the seconds.
- Found in the user's data (the bridge, not the tool): the minute file ends at 20:58 while the 1-second file has 20:59
  (327 contracts) - the tool builds that minute from the seconds and marks it approx; the opening second carries 109
  contracts without an aggressor that the minute file does not have - inside the first minute the tool shows 931,
  from 22:01 the exact 822. Both are findings of `archive.check` and test cases.
- The broker's rules on a hand-made tape; a correction against the old broker: a limit placed when the market already
  lay beyond it fills at the next print, not at the limit (only a resting limit traded through fills at its price).
- The chart loads bars as a need the frame loop serves, never as an event that is lost while a request runs: the old
  page did not load older sessions while playing (a request was always running) - that was the "scrolling back does
  not work" of the old replay.
- `/tl/levels` and the footprint: `[price, volume, buy, sell]`; the data window compares the levels' sums with the
  bar's own figures (✓ / ≠) - on the real day they agree.

- The user compared one 5-minute bar's footprint with ATAS: 10 of 14 rows identical (the archive and ATAS agree), the
  rows around the current price differed - the bar was still forming, and the forming minute is spread from the
  seconds (approx). Open: mark the spread rows in the footprint; build the forming minute from the tick export when
  the bridge wrote one.
- The session VP is not hidden in footprint mode any more (it was, and looked like "everything disappears when
  zooming in"); profiles show their rows' numbers when the rows are tall enough.

- Study settings: "Werkseinstellung" (the built-in defaults), "Als Standard speichern" (kept per study type in the
  browser, taken by every new one and applied to every pane at once); the footprint the same. The session VP's
  built-in defaults are the user's: the whole session, grey rows, the value area lighter, POC red 2 px.

- From the user's first run: the replay bar's knob stood at 0 (a parenthesis in the formula), the arrow keys stepped
  a bar (now a second per press, held down they wind, Shift a minute, Alt a bar; « » step a bar), the footprint mode
  had no price line (now a dashed line like the candles' own), and the chart could stop on "Cannot update oldest data"
  (the chart library refusing an update behind its last bar - the cause was not found; a refused update now falls back
  to setting all bars, so the chart never stays stuck).

- Today's session has no 1-second file yet (the bridge writes it after the day), so the forming minute of an earlier
  moment of today could not be built - the candle appeared whole at the minute's end. Now the forming minute comes
  from the prints the bridge sends live (exact, print by print) whenever they are there, before the seconds; the
  settings page shows per feed whether prints arrive. Without prints from the bridge today stays minute by minute.

- The user's capture of the bridge (tools/bridge_capture.py, 23 Oct 16:49 ET): a message every 50 ms; the full
  snapshot carries 1370 candles with levels [price, volume, bid, ask] (bid = sellers, ask = buyers, as read), the
  forming candle flagged, 98 424 cumulated "trades" (only from Min. Trade contracts - ignored), an order book (ignored),
  and only 10 prints: the prints since the bridge started. Prints are complete single trades (sizes 1, 2, 4; side 1 /
  -1). So today's replay is second-exact from the moment the bridge was started; before that only whole minutes exist
  until the 1-second file is written after the day. The server now keeps the prints on disk (logs/prints) and reads
  them back when the feed returns, so a restart of the server loses none. If the bridge sent the day's prints in its
  snapshot, or wrote the 1-second file during the day, the whole of today would be exact - a change on the bridge's
  side.

- As TradingView: live by default (a fresh server starts live), "Replay" in the top bar starts "Bar wählen" - a line
  follows the mouse, a click or a drag sets the clock there - and the replay bar shows only in replay; its × returns
  to live. Live and replay never exist at once. The footprint's summary rows under the bars are gone (they overlapped
  when zoomed out); the volume histogram stays in every mode.

- Timeframes of seconds (5 s, 15 s, 30 s; tf = 1/12, 1/4, 1/2 of a minute on the routes): built from the bridge's
  prints where they are (exact), else from the 1-second file (o h l c v buyers sellers exact, levels spread - the
  bars carry approx). Checked against the real day's seconds summed by hand.
- The footprint no longer drops a bar's levels when the clock winds back: the entry turns stale and stays drawn
  until the refetched one is there (the flicker the user saw).

- The user's live screenshot (17:42 ET, bridge silent): the current day was gone - a feed that fell silent was
  dropped after 12 s and with it the day's candles. Now a feed is never dropped, only marked stale; its day stays on
  the charts as far as the bridge brought it, is written to logs/live/<root>_<date>.json and read back at the next
  start; the archive's files replace it once the day is fetched. The live account and the forming minute still need
  a fresh feed.

- Home network: LAN=1 in replay.cfg (settings page, "Im Heimnetz erreichbar") binds the server to every address of
  the machine; the Host check then takes IP addresses and the machine's name, never a foreign DNS name; the token
  stays. web/tv/mobile.css lays the page out for an iPad (side bars shrink, finger-sized buttons, hover controls
  always on) and a phone (no drawing bar, trading panel folded). Checked at 1180 × 820, 820 × 1180, 390 × 844 in a
  headless browser - not on a real iPad.

- New charts start with volume, the session VP and the VWAP; the TPO is added via Indikatoren when wanted. The
  legend's indicator rows fold behind a chevron (kept per pane).

- Drawings between windows: localStorage lags between Chromium renderers (a second key's write was not yet visible
  when the first's was), so one window could miss another's deletion. Now every save sends the drawings and the
  deletion log along in the BroadcastChannel message and the windows merge by id and time stamp (newer wins, a
  deletion beats an older stamp; a window's undo brings back only what it deleted itself). Six of six runs of the
  two-window scenario (A draws, B draws, A deletes, B undoes) end consistent.
- The cursor of one window shows in the others (BroadcastChannel "tv-cross", a few times a second; the own mouse
  wins). A floating drawing bar on the chart (TradingView's) with the common tools, draggable, off in the settings.
  Live without a feed: the chip reads "No Live Market Data" in grey instead of a red LIVE.
- Quantities in tenths of a contract (0.1 ES behaves like one MES, with the big contract's prints and a tenth of its
  point value) in the broker, the ticket, the labels and the panel; "Max. Risiko": the contracts follow the risk
  amount and the stop-loss distance, rounded down to a tenth.

## Checked in the browser (headless Chromium, the real day plus synthetic days)

Scrolling back while playing at 30x loads the older sessions all the way (from = 0); the footprint on the real day at
one tick per row; the data window; the settings page with the day check.

## Not checked

The user's full archive, Windows, a real GPU, live with the bridge (only the ingest contract and paper trading through
the server in tests), several instruments.

## Open

- The TradingView-like page (`web/tv/*`) was written for the older tool's page and brought over; it is clean of
  references to it, but its own cleanup (the studies' AMT service, the trade module) is lighter than the server's.
- One account per CME trade date (the broker's); an account across days is not there.
- Trailing stops, stacked imbalances, a delta histogram pane under the footprint, saved layouts by name.

## Working rules (the user's)

Say whether a delivery is the whole repository or only changed files. Keep a copy of the version the user runs before
replacing it. No feature may fall back to an approximation silently: every approximated value is marked (forming,
approx, "the order inside a second assumed"). Tests check against the files, never against the code under test.
