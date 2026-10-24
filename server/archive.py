"""
archive.py - the Rithmic Bridge's archive (nickwick-rithmic-bridge), read into arrays.

Layout, one file set per session named by its trade date:
  <base>/1m-bars/<ROOT>/<date>_bars.csv     minute_utc, open, high, low, close, volume, buy_aggr, sell_aggr, delta, trades
  <base>/1m-bars/<ROOT>/<date>_levels.csv   minute_utc, price, volume, buy_aggr, sell_aggr, no_aggr - volume per price
  <base>/1m-bars/<ROOT>/<date>.meta.json    status "complete" = the day is there; "empty" = a holiday
  <base>/1s-bars/<ROOT>/<date>_1s.csv       second_utc, open, high, low, close, volume, buy_aggr, sell_aggr, trades
                                            (only seconds that traded)
  <base>/ticks/<ROOT>/<date>_ticks.csv      ts_ns, price, size, side (B / S / empty) - every trade, when its
                                            <date>_ticks.meta.json says complete
buy_aggr = contracts bought at the ask (the buyer aggressed), sell_aggr = sold at the bid. Prices are multiples of the
tick; inside the tool a price is an integer number of ticks.

A Day holds a session's minutes and levels as numpy arrays; every file is read once and kept (by its modification
time), a finished day never changes. check() lists what does not add up inside a day's files - the tool shows these
on the settings page instead of hiding them (the user's 2026-10-12: the 1-second file has 109 contracts without an
aggressor in the opening second that the minute file does not have, and a last minute 20:59 the minute file lacks).
"""
import json
import os
import re
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import session
import specs

TICK = 0.25                                   # the default; a Day carries its symbol's tick (specs.py)
_CONTRACT = re.compile(r"^([A-Z0-9]+?)([FGHJKMNQUVXZ]\d{1,2})$")


def root_of(instrument):
    """ESZ6 -> ES, ES -> ES: the archive folder of a contract"""
    m = _CONTRACT.match(instrument or "")
    return m.group(1) if m else (instrument or "")


def _epochs(col):
    """a column of ISO UTC strings -> epoch seconds (int64)"""
    e = pd.Timestamp("1970-01-01", tz="UTC")
    return ((pd.to_datetime(col, utc=True) - e) // pd.Timedelta(seconds=1)).to_numpy(np.int64)


class Day:
    """one session's minutes: t (epoch of the minute's start), o h l c, v, buy, sell; its levels flat: lv_i (index of
    the minute), lv_p (price in ticks), lv_v, lv_buy, lv_sell"""
    __slots__ = ("root", "td", "t", "o", "h", "l", "c", "v", "buy", "sell", "src", "lv_i", "lv_p", "lv_v", "lv_buy", "lv_sell", "stamp", "tick")
    FILE, SECONDS, LIVE = 0, 1, 2                 # src: where a minute comes from (built from seconds = approximate levels)

    @staticmethod
    def empty(root, td):
        d = Day(); d.root, d.td, d.stamp, d.tick = root, td, "", specs.tick_of(root)
        for f in ("t", "lv_i", "lv_p", "lv_v", "lv_buy", "lv_sell", "v", "buy", "sell", "src"):
            setattr(d, f, np.array([], np.int64))
        for f in ("o", "h", "l", "c"):
            setattr(d, f, np.array([], np.float64))
        return d

    @staticmethod
    def from_minutes(root, td, rows):
        """rows: dicts {t, o, h, l, c, v, buy, sell, levels: [[price, v, buy, sell], ...]} (the live feed)"""
        rows = sorted(rows, key=lambda r: r["t"])
        d = Day.empty(root, td)
        d.t = np.array([r["t"] for r in rows], np.int64)
        for f in ("o", "h", "l", "c"):
            setattr(d, f, np.array([r[f] for r in rows], np.float64))
        for f in ("v", "buy", "sell"):
            setattr(d, f, np.array([r.get(f, 0) for r in rows], np.int64))
        d.src = np.array([r.get("src", Day.LIVE) for r in rows], np.int64)
        i, p, v, b, s = [], [], [], [], []
        for k, r in enumerate(rows):
            for price, vol, bu, se in r.get("levels") or []:
                i.append(k); p.append(int(round(price / d.tick))); v.append(int(vol)); b.append(int(bu)); s.append(int(se))
        d.lv_i, d.lv_p, d.lv_v, d.lv_buy, d.lv_sell = (np.array(x, np.int64) for x in (i, p, v, b, s))
        return d

    def window(self, t0, t1):
        """the minutes in [t0, t1) as a Day of their own"""
        a, b = int(np.searchsorted(self.t, t0, "left")), int(np.searchsorted(self.t, t1, "left"))
        if a == 0 and b == self.t.size:
            return self
        return self.take(np.arange(a, b))

    def take(self, idx):
        d = Day.empty(self.root, self.td); d.stamp = self.stamp; d.tick = self.tick
        for f in ("t", "o", "h", "l", "c", "v", "buy", "sell", "src"):
            setattr(d, f, getattr(self, f)[idx])
        remap = np.full(self.t.size, -1, np.int64); remap[idx] = np.arange(idx.size)
        sel = remap[self.lv_i] >= 0
        d.lv_i = remap[self.lv_i[sel]]
        for f in ("lv_p", "lv_v", "lv_buy", "lv_sell"):
            setattr(d, f, getattr(self, f)[sel])
        return d

    def until(self, until):
        """the whole minutes that ended at or before `until`"""
        k = int(np.searchsorted(self.t, until - 60, "right"))
        return self if k >= self.t.size else self.take(np.arange(k))

    @staticmethod
    def concat(days):
        """several Days into one, in time order; a later Day's minute replaces an earlier one's at the same time"""
        days = [d for d in days if d is not None and d.t.size]
        if not days:
            return None
        if len(days) == 1:
            return days[0]
        root, td = days[-1].root, days[-1].td
        rows = {}
        for d in days:
            for k, t in enumerate(d.t.tolist()):
                rows[t] = (d, k)
        order = sorted(rows)
        out = Day.empty(root, td); out.tick = days[-1].tick
        out.t = np.array(order, np.int64)
        picks = [rows[t] for t in order]
        for f in ("o", "h", "l", "c", "v", "buy", "sell", "src"):
            setattr(out, f, np.array([getattr(d, f)[k] for d, k in picks]))
        i, p, v, b, s = [], [], [], [], []
        for n, (d, k) in enumerate(picks):
            sel = np.flatnonzero(d.lv_i == k)
            i.append(np.full(sel.size, n, np.int64)); p.append(d.lv_p[sel]); v.append(d.lv_v[sel]); b.append(d.lv_buy[sel]); s.append(d.lv_sell[sel])
        cat = lambda xs: np.concatenate(xs) if xs else np.array([], np.int64)
        out.lv_i, out.lv_p, out.lv_v, out.lv_buy, out.lv_sell = cat(i), cat(p), cat(v), cat(b), cat(s)
        return out


class Archive:
    def __init__(self, base):
        self.base = base or ""
        self._days = {}                              # (root, td, stamp) -> Day
        self._seconds = {}                           # (root, td, stamp) -> arrays
        self._ticks = {}                             # (root, td, stamp) -> arrays

    # ---- what is there
    def minute_dir(self, root):
        return os.path.join(self.base, "1m-bars", root)

    def second_dir(self, root):
        return os.path.join(self.base, "1s-bars", root)

    def tick_dir(self, root):
        return os.path.join(self.base, "ticks", root)

    def roots(self):
        d = os.path.join(self.base, "1m-bars")
        try:
            return sorted(x for x in os.listdir(d) if os.path.isdir(os.path.join(d, x)))
        except OSError:
            return []

    def meta(self, root, td):
        try:
            with open(os.path.join(self.minute_dir(root), f"{td}.meta.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def days(self, root):
        """the trade dates of a root that are complete, oldest first"""
        d = self.minute_dir(root)
        try:
            names = os.listdir(d)
        except OSError:
            return []
        out = []
        for n in sorted(names):
            if n.endswith(".meta.json"):
                td = n[:-len(".meta.json")]
                m = self.meta(root, td)
                if m and m.get("status") == "complete" and os.path.exists(os.path.join(d, f"{td}_bars.csv")) \
                        and os.path.exists(os.path.join(d, f"{td}_levels.csv")):
                    out.append(td)
        return out

    def _stamp(self, *paths):
        return "|".join(f"{os.path.getmtime(p):.0f}" if os.path.exists(p) else "-" for p in paths)

    # ---- a session's minutes and levels
    def day(self, root, td):
        """the Day of a trade date, or None when its files are not there"""
        pb, pl = os.path.join(self.minute_dir(root), f"{td}_bars.csv"), os.path.join(self.minute_dir(root), f"{td}_levels.csv")
        if not (os.path.exists(pb) and os.path.exists(pl)):
            return None
        key = (root, td, self._stamp(pb, pl))
        if key not in self._days:
            self._days = {k: v for k, v in self._days.items() if k[:2] != (root, td)}
            self._days[key] = self._read_day(root, td, pb, pl, key[2])
            if len(self._days) > 300:
                self._days.pop(next(iter(self._days)))
        return self._days[key]

    @staticmethod
    def _read_day(root, td, pb, pl, stamp):
        b = pd.read_csv(pb)
        b = b.assign(_t=_epochs(b["minute_utc"])).sort_values("_t", kind="stable").drop_duplicates("_t", keep="last")
        d = Day.empty(root, td); d.stamp = stamp
        d.t = b["_t"].to_numpy(np.int64)
        for f, col in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close")):
            setattr(d, f, b[col].to_numpy(np.float64))
        d.v, d.buy, d.sell = (b[col].to_numpy(np.int64) for col in ("volume", "buy_aggr", "sell_aggr"))
        d.src = np.zeros(d.t.size, np.int64)
        lv = pd.read_csv(pl)
        specs.learn(root, lv["price"].to_numpy(np.float64)[:20000].tolist())      # an unknown symbol: its tick from its prices
        d.tick = specs.tick_of(root)
        lt = _epochs(lv["minute_utc"])
        i = np.searchsorted(d.t, lt)
        ok = (i < d.t.size) & (d.t[np.minimum(i, d.t.size - 1)] == lt)      # levels of a minute the bars lack: dropped
        lv, i = lv[ok], i[ok]
        order = np.argsort(i, kind="stable")
        d.lv_i = i[order].astype(np.int64)
        d.lv_p = np.round(lv["price"].to_numpy(np.float64)[order] / d.tick).astype(np.int64)
        d.lv_v, d.lv_buy, d.lv_sell = (lv[col].to_numpy(np.int64)[order] for col in ("volume", "buy_aggr", "sell_aggr"))
        return d

    # ---- 1-second bars: (t, o, h, l, c, v, buy, sell) arrays, seconds that traded
    def seconds(self, root, td):
        p = os.path.join(self.second_dir(root), f"{td}_1s.csv")
        if not os.path.exists(p):
            return None
        key = (root, td, self._stamp(p))
        if key not in self._seconds:
            self._seconds = {k: v for k, v in self._seconds.items() if k[:2] != (root, td)}
            s = pd.read_csv(p)
            s = s.assign(_t=_epochs(s["second_utc"])).sort_values("_t", kind="stable")
            self._seconds[key] = tuple(s[c].to_numpy(dt) for c, dt in (("_t", np.int64), ("open", np.float64), ("high", np.float64),
                                                                        ("low", np.float64), ("close", np.float64), ("volume", np.int64),
                                                                        ("buy_aggr", np.int64), ("sell_aggr", np.int64)))
            if len(self._seconds) > 40:
                self._seconds.pop(next(iter(self._seconds)))
        return self._seconds[key]

    def seconds_in(self, root, t0, t1):
        """the seconds of [t0, t1) from the sessions those moments belong to"""
        tds = sorted({session.trade_date(t0), session.trade_date(t1 - 1)})
        parts = [self.seconds(root, td) for td in tds]
        parts = [p for p in parts if p is not None]
        if not parts:
            return None
        cols = [np.concatenate([p[i] for p in parts]) for i in range(8)]
        order = np.argsort(cols[0], kind="stable")
        cols = [c[order] for c in cols]
        a, b = np.searchsorted(cols[0], t0, "left"), np.searchsorted(cols[0], t1, "left")
        return tuple(c[a:b] for c in cols)

    # ---- the tick export: (t, price, size, side) arrays, side +1 buyer, -1 seller, 0 unknown - or None
    def ticks(self, root, td):
        p, pm = os.path.join(self.tick_dir(root), f"{td}_ticks.csv"), os.path.join(self.tick_dir(root), f"{td}_ticks.meta.json")
        if not (os.path.exists(p) and os.path.exists(pm)):
            return None
        try:
            with open(pm, encoding="utf-8") as f:
                if json.load(f).get("status") != "complete":
                    return None
        except (OSError, ValueError):
            return None
        key = (root, td, self._stamp(p))
        if key not in self._ticks:
            self._ticks.clear()
            d = pd.read_csv(p, dtype={"side": str}, keep_default_na=False)
            side = d["side"].map({"B": 1, "S": -1}).fillna(0).to_numpy(np.int8)
            self._ticks[key] = (d["ts_ns"].to_numpy(np.int64) / 1e9, d["price"].to_numpy(np.float64), d["size"].to_numpy(np.float32), side)
        return self._ticks[key]

    # ---- what does not add up inside a day's files
    def check(self, root, td):
        """findings about a day's files, each {kind, text, ...}; [] when everything adds up"""
        out = []
        d = self.day(root, td)
        if d is None:
            return [{"kind": "missing", "text": "no minute files"}]
        lv_sum = np.bincount(d.lv_i, d.lv_v, minlength=d.t.size) if d.lv_i.size else np.zeros(d.t.size)
        bad = np.flatnonzero(lv_sum != d.v)
        for k in bad[:20]:
            out.append({"kind": "levels", "t": int(d.t[k]), "text": f"levels add up to {int(lv_sum[k])}, the minute's volume is {int(d.v[k])}"})
        if bad.size > 20:
            out.append({"kind": "levels", "text": f"... {bad.size} minutes in all"})
        start, end = session.bounds(td)
        if d.t.size:
            if d.t[0] > start:
                out.append({"kind": "gap", "t": int(start), "text": f"the first minute is {_iso(d.t[0])}, the session starts {_iso(start)}"})
            if d.t[-1] + 60 < end:
                out.append({"kind": "gap", "t": int(d.t[-1] + 60), "text": f"the last minute is {_iso(d.t[-1])}, the session ends {_iso(end)}"})
            gaps = np.flatnonzero(np.diff(d.t) > 60)
            for k in gaps[:20]:
                out.append({"kind": "gap", "t": int(d.t[k] + 60), "text": f"no minutes from {_iso(d.t[k] + 60)} to {_iso(d.t[k + 1])}"})
        s = self.seconds(root, td)
        if s is not None and d.t.size:
            st, sv, sbuy, ssell = s[0], s[5], s[6], s[7]
            minute = (st // 60) * 60
            um, inv = np.unique(minute, return_inverse=True)
            vsum = np.bincount(inv, sv); bsum = np.bincount(inv, sbuy); ssum = np.bincount(inv, ssell)
            i = np.searchsorted(d.t, um)
            have = (i < d.t.size) & (d.t[np.minimum(i, d.t.size - 1)] == um)
            for k in np.flatnonzero(~have)[:10]:
                out.append({"kind": "seconds", "t": int(um[k]), "text": f"minute {_iso(um[k])} is in the 1-second file ({int(vsum[k])} contracts) but not in the minute file"})
            diff = np.flatnonzero(have & (vsum != d.v[np.minimum(i, d.t.size - 1)]))
            for k in diff[:10]:
                out.append({"kind": "seconds", "t": int(um[k]), "text": f"minute {_iso(um[k])}: the seconds add up to {int(vsum[k])}, the minute file says {int(d.v[i[k]])} "
                                                                          f"({int(vsum[k] - bsum[k] - ssum[k])} without an aggressor)"})
        else:
            out.append({"kind": "seconds", "text": "no 1-second file: the forming minute cannot be shown, orders cannot fill here"})
        return out


def _iso(t):
    return datetime.fromtimestamp(int(t), timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
