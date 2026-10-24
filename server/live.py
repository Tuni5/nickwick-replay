"""
live.py - today's session as the Rithmic Bridge sends it (POST /ingest, the bridge's "Viewer" URL).

A message carries the bridge's source id (one per instrument), the instrument (ESZ6), its chart's timeframe, 1-minute
candles with their price levels, and every print since the last message ("ticks": [[epoch us, price, size, side]])
for paper trading. A full snapshot ("full": true) replaces the day; deltas carry the changed candles. Feeds are
keyed by the source id, so a restarted bridge replaces its own feed. A feed without a message for STALE seconds is
stale: its day stays on the charts (the day as far as the bridge brought it), only the live account and the forming
minute need a fresh feed. Nothing is dropped: the day's candles are written to <logs>/live/<root>_<trade date>.json
as they come and read back at the next start, so a stopped bridge or a restarted server does not lose the day; the
archive's files replace them once the day is in the archive. Messages without instrument / timeframe are refused
(425), deltas from unknown sources too (409) - both make the bridge resend a snapshot.

Candle fields the bridge sends: time (ISO UTC), o h l c, v, ask = bought at the ask (buyers), bid = sold at the bid
(sellers), lv [[price, volume, bid, ask], ...]. Inside the tool: buy = ask, sell = bid. A full snapshot carries the
day's candles but only the prints since the bridge started (seen in the user's capture of 23 Oct: 1370 candles, 10
ticks), so today's prints exist only from that moment on. They are written to <logs>/prints/<root>_<trade date>.csv as
they come and read back when the feed reappears (a server restart does not lose them); the forming minute of an
earlier moment of today comes from them (timeline.py). What the bridge also sends - trades (cumulated, from "Min.
Trade" contracts), the order book (depth), profile - is ignored.
"""
import json
import os
import threading
import time
from datetime import datetime, timezone

import numpy as np

import archive
import session
from ticks import TickStore

STALE_S, EXPIRE_S = 6, 12                 # the bridge sends a heartbeat every 3 s
TICKS_KEEP_H = 24.0                       # a session's prints stay: the broker recomputes the day from them


def _epoch(iso):
    base = iso.rstrip("Z").split(".")[0]
    return int(datetime.fromisoformat(base).replace(tzinfo=timezone.utc).timestamp())


class Feeds:
    def __init__(self, prints_dir=None, live_dir=None):
        self.lock = threading.Lock()
        self._feeds = {}                  # source id -> feed
        self.prints_dir = prints_dir      # where today's prints are kept on disk (None: memory only)
        self.live_dir = live_dir          # where the live day's candles are kept on disk (None: memory only)
        self._load_days()

    def ingest(self, msg):
        """a message from the bridge -> (http status, text)"""
        if msg.get("instrument", "?") in ("?", "", None) or msg.get("timeframe", "?") in ("?", "", None):
            return 425, "instrument or timeframe unknown yet, resend"
        src = msg.get("source") or f"{msg.get('instrument')}:{msg.get('timeframe')}"
        with self.lock:
            f = self._feeds.get(src)
            if msg.get("heartbeat"):
                if f is None:
                    return 409, "unknown source, send a full snapshot"
                f["at"] = time.time()
                return 200, "ok"
            if f is None and not msg.get("full"):
                return 409, "unknown source, send a full snapshot"
            key = f"{msg['instrument']}:{msg['timeframe']}"
            if f is None or f["key"] != key:
                f = self._feeds[src] = {"src": src, "key": key, "instrument": msg["instrument"], "timeframe": msg["timeframe"],
                                        "tick": float(msg.get("tick") or 0.25), "candles": {}, "ticks": None, "messages": 0, "at": 0.0, "day": None}
            if msg.get("full"):
                f["candles"].clear()
            for c in msg.get("candles") or []:
                f["candles"][c["time"]] = c
            store = None
            if msg.get("ticks"):
                if f["ticks"] is None:
                    f["ticks"] = TickStore(TICKS_KEEP_H)
                    self._load_prints(f)
                store = f["ticks"]
            f["messages"] += 1
            f["at"] = time.time()
            f["day"] = None                                 # rebuilt on the next ask
            if msg.get("candles") and (msg.get("full") or time.time() - f.get("saved", 0) > 10):
                self._save_day(f)
        if store is not None:                               # outside the lock: the store has its own
            try:
                rows = [r for r in msg["ticks"] if r is not None and len(r) >= 3]
                if msg.get("full") and store.n > store.start:   # a snapshot after a restart: what is on disk already stays
                    last = float(store.t[store.n - 1])
                    rows = [r for r in rows if float(r[0]) / 1e6 > last]
                store.add(rows)
                self._save_prints(f, rows)
            except (TypeError, ValueError) as ex:
                return 400, f"ticks: {ex}"
        return 200, "ok"

    # ---- today's prints on disk: <prints_dir>/<root>_<trade date>.csv, "t_us,price,size,side" lines appended
    def _prints_path(self, f, t=None):
        if not self.prints_dir:
            return None
        td = session.trade_date(t if t is not None else time.time())
        return os.path.join(self.prints_dir, f"{archive.root_of(f['instrument'])}_{td}.csv")

    def _save_prints(self, f, rows):
        p = self._prints_path(f, float(rows[0][0]) / 1e6 if rows else None)
        if not p or not rows:
            return
        os.makedirs(self.prints_dir, exist_ok=True)
        with open(p, "a", encoding="utf-8") as fh:
            fh.writelines(f"{int(r[0])},{r[1]},{r[2]},{int(r[3]) if len(r) > 3 else 0}\n" for r in rows)

    def _load_prints(self, f):
        p = self._prints_path(f)
        if not p or not os.path.exists(p):
            return
        try:
            d = np.loadtxt(p, delimiter=",", ndmin=2)
        except (OSError, ValueError):
            return
        if d.size:
            f["ticks"]._append(d[:, 0] / 1e6, d[:, 1].astype(np.float64), d[:, 2].astype(np.float32), d[:, 3].astype(np.int8))

    def _sweep(self):
        pass                                                # nothing is dropped: a feed that fell silent is stale

    # ---- the live day's candles on disk: <live_dir>/<root>_<trade date>.json
    def _day_path(self, f):
        if not self.live_dir or not f["candles"]:
            return None
        td = session.trade_date(_epoch(max(f["candles"])))
        return os.path.join(self.live_dir, f"{archive.root_of(f['instrument'])}_{td}.json")

    def _save_day(self, f):
        p = self._day_path(f)
        if not p:
            return
        try:
            os.makedirs(self.live_dir, exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"src": f["src"], "instrument": f["instrument"], "timeframe": f["timeframe"], "tick": f["tick"], "candles": list(f["candles"].values())}, fh)
            os.replace(tmp, p)
            f["saved"] = time.time()
        except OSError:
            pass

    def _load_days(self):
        """at start: the days the bridge sent earlier (stale feeds, their candles)"""
        if not self.live_dir or not os.path.isdir(self.live_dir):
            return
        for name in sorted(os.listdir(self.live_dir)):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.live_dir, name), encoding="utf-8") as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            src = d.get("src") or name[:-5]
            f = self._feeds.get(src)
            if f is None or _epoch(max(d["candles"], key=lambda c: c["time"])["time"]) > max((_epoch(x) for x in f["candles"]), default=0):
                self._feeds[src] = {"src": src, "key": f"{d['instrument']}:{d['timeframe']}", "instrument": d["instrument"], "timeframe": d["timeframe"],
                                    "tick": float(d.get("tick") or 0.25), "candles": {c["time"]: c for c in d["candles"]}, "ticks": None,
                                    "messages": 0, "at": 0.0, "day": None, "saved": time.time()}

    def rows(self):
        """for /feeds and the settings page"""
        with self.lock:
            self._sweep()
            out = []
            for f in self._feeds.values():
                age = time.time() - f["at"]
                ts = sorted(f["candles"])
                spacing = None
                if len(ts) >= 3:
                    ep = [_epoch(x) for x in ts[-20:]]
                    d = [b - a for a, b in zip(ep, ep[1:]) if b > a]
                    spacing = min(d) if d else None
                out.append({"src": f["src"], "instrument": f["instrument"], "root": archive.root_of(f["instrument"]), "timeframe": f["timeframe"],
                            "candle_seconds": spacing, "age_s": round(age, 1), "stale": age > STALE_S, "messages": f["messages"],
                            "ticks": f["ticks"] is not None, "minutes": len(f["candles"])})
            return out

    def _fresh(self, root):
        """the freshest feed of a symbol (ESZ6 counts for ES) that is not stale"""
        rows = [f for f in self._feeds.values() if archive.root_of(f["instrument"]) == root and time.time() - f["at"] <= STALE_S]
        return min(rows, key=lambda f: time.time() - f["at"]) if rows else None

    def _newest(self, root):
        """the feed of a symbol with the newest candles, stale or not - the day as far as the bridge brought it"""
        rows = [f for f in self._feeds.values() if archive.root_of(f["instrument"]) == root and f["candles"]]
        return max(rows, key=lambda f: max(f["candles"])) if rows else None

    def day(self, root):
        """the live minutes of a symbol as an archive.Day (for the timeline), or None"""
        with self.lock:
            f = self._newest(root)
            if f is None:
                return None
            if f["day"] is None:
                rows = []
                for c in f["candles"].values():
                    rows.append({"t": _epoch(c["time"]), "o": float(c["o"]), "h": float(c["h"]), "l": float(c["l"]), "c": float(c["c"]),
                                 "v": int(c.get("v") or 0), "buy": int(c.get("ask") or 0), "sell": int(c.get("bid") or 0),
                                 "levels": [[float(p), int(q), int(a), int(b)] for p, q, b, a in (c.get("lv") or [])]})
                f["day"] = archive.Day.from_minutes(root, "", rows)
            return f["day"]

    def prints_of(self, root):
        """today's prints of a symbol as arrays (t, price, size, side), from its freshest feed - for the forming
        minute while the day's 1-second file does not exist yet; None without prints"""
        with self.lock:
            f = self._fresh(root)
            ts = f["ticks"] if f else None
            if ts is None or ts.n == ts.start:
                return None
            s, n = ts.start, ts.n
            return ts.t[s:n], ts.px[s:n], ts.sz[s:n], ts.side[s:n]

    def prints(self, src):
        """the TickStore of a feed by source id, or None"""
        with self.lock:
            f = self._feeds.get(src)
            if f is None or f["ticks"] is None or f["ticks"].n == f["ticks"].start:
                return None
            return f, f["ticks"]

    def clear(self):
        with self.lock:
            self._feeds.clear()
