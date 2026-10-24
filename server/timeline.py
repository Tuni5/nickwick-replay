"""
timeline.py - one continuous 1-minute timeline per instrument, and from it the bars of any timeframe, the volume per
price of every bar and the profile of any range - always cut at a moment, the replay clock ("until"): nothing after
it leaves here.

Sources of a session's minutes, in this order of trust:
  the live feed       today's session as the Rithmic Bridge sends it (live.py), kept as far as it came even when
                      the bridge fell silent - until the day's files are in the archive
  the minute files    the archive's 1m bars with their levels, exact (archive.py)
  the 1-second file   only for minutes the minute file does not have although the seconds do (the user's 2026-10-12
                      lacks its last minute 20:59): o h l c, volume, buyers and sellers are exact, the levels are
                      spread over each second's range - such a bar is marked approx
The rule of exactness: a whole minute shown is its minute file's row. Only the minute the clock stands in is built
up to the clock and marked forming: from the bridge's prints when it sends them (today's session, before its
1-second file exists - exact, print by print), else from the 1-second file (o h l c v buyers sellers exact, the
levels spread over each second's range).
"""
import numpy as np

import session
from archive import Day, TICK

CACHE = 400


def _spread(secs, t0, t1):
    """the seconds in [t0, t1) as one minute dict: o h l c v buy sell exact, levels spread evenly over each second's
    tick range, whole contracts, the totals kept (largest remainder)"""
    st, so, sh, sl, sc, sv, sbuy, ssell = secs
    a, b = np.searchsorted(st, t0, "left"), np.searchsorted(st, t1, "left")
    if b <= a:
        return None
    o, c = float(so[a]), float(sc[b - 1])
    h, l = float(sh[a:b].max()), float(sl[a:b].min())
    v, buy, sell = int(sv[a:b].sum()), int(sbuy[a:b].sum()), int(ssell[a:b].sum())
    lv = {}
    for k in range(a, b):
        lo, hi = int(round(sl[k] / TICK)), int(round(sh[k] / TICK))
        n = hi - lo + 1
        for p in range(lo, hi + 1):
            e = lv.setdefault(p, [0.0, 0.0, 0.0])
            e[0] += sv[k] / n; e[1] += sbuy[k] / n; e[2] += ssell[k] / n
    ps = sorted(lv)
    vv, bb, ss = (_whole([lv[p][i] for p in ps], tot) for i, tot in ((0, v), (1, buy), (2, sell)))
    return {"t": int((t0 // 60) * 60), "o": o, "h": h, "l": l, "c": c, "v": v, "buy": buy, "sell": sell,
            "levels": [[p * TICK, vv[i], bb[i], ss[i]] for i, p in enumerate(ps)], "src": Day.SECONDS}


def _whole(shares, total):
    """fractional shares -> whole numbers adding up to `total` (largest remainder)"""
    base = [int(x) for x in shares]
    left = int(round(total)) - sum(base)
    order = sorted(range(len(shares)), key=lambda i: shares[i] - base[i], reverse=True)
    for i in order[:max(0, left)]:
        base[i] += 1
    return base


def value_area(levels):
    """levels [[price, volume, ...], ...] sorted by price: POC, VAH, VAL, total. The value area starts at the POC and
    adds the larger neighbouring level (the upper on a tie) until it holds 70 % of the volume; of equal maxima the
    lowest price is the POC."""
    vols = [lv[1] for lv in levels]
    total = sum(vols)
    i = max(range(len(vols)), key=lambda k: (vols[k], -k))
    lo = hi = i
    acc = vols[i]
    while acc < total * 0.7 and (lo > 0 or hi < len(vols) - 1):
        up = vols[hi + 1] if hi < len(vols) - 1 else -1
        dn = vols[lo - 1] if lo > 0 else -1
        if up >= dn:
            hi += 1; acc += up
        else:
            lo -= 1; acc += dn
    return {"poc": levels[i][0], "vah": levels[hi][0], "val": levels[lo][0], "total": total}


class Timeline:
    def __init__(self, archive, live=None, prints=None):
        self.archive = archive
        self.live = live or (lambda root: None)             # root -> Day of today's session, or None
        self.prints = prints or (lambda root: None)         # root -> (t, price, size, side) arrays of today's prints, or None
        self._sessions = {}                                 # (root, td, stamp) -> Day
        self._bars = {}                                     # (root, td, tf, stamp) -> bars of the finished session

    # ---- which sessions exist
    def roots(self):
        return self.archive.roots()

    def sessions(self, root):
        """trade dates with minutes, oldest first: the archive's and the live one"""
        out = set(self.archive.days(root))
        live = self.live(root)
        if live is not None and live.t.size:
            out.add(session.trade_date(int(live.t[-1])))
        return sorted(out)

    def _in(self, root, t0, t1, until):
        hi = t1 if until is None else min(t1, until)
        return [td for td in self.sessions(root) if session.bounds(td)[1] > t0 and session.bounds(td)[0] < hi]

    # ---- a session's minutes
    def _stamp(self, root, td):
        parts = []
        for d in session.neighbours(td):
            day = self.archive.day(root, d)
            if day is not None:
                parts.append(d + ":" + day.stamp)
        return "|".join(parts)

    def minutes(self, root, td):
        """the session's minutes as a Day: the archive files of the trade date and the dates either side, windowed to
        the session; minutes only the seconds have, built from them; the live feed's minutes on top. None if none."""
        start, end = session.bounds(td)
        live = self.live(root)
        live_here = live.window(start, end) if live is not None and live.t.size else None
        if live_here is not None and (not live_here.t.size or td in self.archive.days(root)):   # the archive's files win once the day is there
            live_here = None
        stamp = self._stamp(root, td)
        key = (root, td, stamp)
        base = self._sessions.get(key)
        if base is None:
            parts = []
            for d in session.neighbours(td):
                day = self.archive.day(root, d)
                if day is not None:
                    parts.append(day.window(start, end))
            base = Day.concat(parts)
            extra = self._minutes_only_in_seconds(root, td, base, start, end)
            if extra is not None:
                base = Day.concat([base, extra])
            if base is None:
                base = Day.empty(root, td)
            self._sessions[key] = base
            while len(self._sessions) > CACHE:
                self._sessions.pop(next(iter(self._sessions)))
        if live_here is not None:
            return Day.concat([base, live_here])
        return base if base.t.size else None

    def _minutes_only_in_seconds(self, root, td, base, start, end):
        secs = self.archive.seconds(root, td)
        if secs is None or not secs[0].size:
            return None
        mins = np.unique((secs[0] // 60) * 60)
        mins = mins[(mins >= start) & (mins < end)]
        if base is not None and base.t.size:
            mins = mins[~np.isin(mins, base.t)]
        if not mins.size:
            return None
        rows = [_spread(secs, int(m), int(m) + 60) for m in mins]
        return Day.from_minutes(root, td, [r for r in rows if r is not None])

    # ---- the minute the clock stands in
    def forming(self, root, until):
        """what there is of the minute `until` falls into, from its seconds; live: the feed's own forming minute"""
        m0 = int(until // 60) * 60
        if until <= m0:
            return None
        live = self.live(root)
        if live is not None and live.t.size and int(live.t[-1]) == m0:
            k = live.t.size - 1
            sel = live.lv_i == k
            return {"t": m0, "o": float(live.o[k]), "h": float(live.h[k]), "l": float(live.l[k]), "c": float(live.c[k]),
                    "v": int(live.v[k]), "buy": int(live.buy[k]), "sell": int(live.sell[k]), "src": Day.LIVE,
                    "levels": [[float(p * TICK), int(v), int(b), int(s)] for p, v, b, s in zip(live.lv_p[sel], live.lv_v[sel], live.lv_buy[sel], live.lv_sell[sel])]}
        pm = self._from_prints(root, m0, until)
        if pm is not None:
            return pm
        secs = self.archive.seconds_in(root, m0, until)
        if secs is None or not secs[0].size:
            return None
        return _spread(secs, m0, until)

    def _from_prints(self, root, m0, until):
        """the minute from the bridge's prints in [m0, until): exact, every trade at its price with its side"""
        pr = self.prints(root)
        if pr is None:
            return None
        t, px, sz, side = pr
        a, b = np.searchsorted(t, m0, "left"), np.searchsorted(t, until, "left")
        if b <= a:
            return None
        px, sz, side = px[a:b], sz[a:b], side[a:b]
        pt = np.round(px / TICK).astype(np.int64)
        pmin = int(pt.min())
        v = np.bincount(pt - pmin, sz); buy = np.bincount(pt - pmin, sz * (side > 0)); sell = np.bincount(pt - pmin, sz * (side < 0))
        idx = np.flatnonzero(v > 0)
        return {"t": int(m0), "o": float(px[0]), "h": float(px.max()), "l": float(px.min()), "c": float(px[-1]),
                "v": int(round(float(sz.sum()))), "buy": int(round(float(sz[side > 0].sum()))), "sell": int(round(float(sz[side < 0].sum()))),
                "levels": [[(int(i) + pmin) * TICK, int(round(v[i])), int(round(buy[i])), int(round(sell[i]))] for i in idx], "src": Day.LIVE}

    # ---- bars
    @staticmethod
    def _aggregate(d, tf, start):
        """Day -> bars of tf minutes (no levels)"""
        if d.t.size == 0:
            return []
        starts = np.array([session.bucket_start(int(t), tf, start) for t in d.t.tolist()], np.int64) if tf < 1440 else np.full(d.t.size, start, np.int64)
        cut = np.flatnonzero(np.r_[True, starts[1:] != starts[:-1]])
        ends = np.r_[cut[1:], d.t.size]
        out = []
        for i in range(cut.size):
            a, b = cut[i], ends[i]
            buy, sell = int(d.buy[a:b].sum()), int(d.sell[a:b].sum())
            out.append({"t": int(starts[a]), "o": float(d.o[a]), "h": float(d.h[a:b].max()), "l": float(d.l[a:b].min()), "c": float(d.c[b - 1]),
                        "v": int(d.v[a:b].sum()), "buy": buy, "sell": sell, "delta": buy - sell, "forming": False,
                        "approx": bool((d.src[a:b] == Day.SECONDS).any())})
        return out

    def _session_bars(self, root, td, tf, until):
        d = self.minutes(root, td)
        if d is None:
            return []
        start, end = session.bounds(td)
        finished = until is None or until >= end
        live = self.live(root)
        is_live = live is not None and live.t.size and session.trade_date(int(live.t[-1])) == td
        key = (root, td, tf, self._stamp(root, td))
        if finished and not is_live and key in self._bars:
            return self._bars[key]
        bars = self._aggregate(d if finished else d.until(until), tf, start)
        if not finished:
            pm = self.forming(root, until)
            if pm is not None and start <= pm["t"] < end:
                bs = session.bucket_start(pm["t"], tf, start)
                if bars and bars[-1]["t"] == bs:
                    b = dict(bars[-1])
                    b["h"] = max(b["h"], pm["h"]); b["l"] = min(b["l"], pm["l"]); b["c"] = pm["c"]
                    b["v"] += pm["v"]; b["buy"] += pm["buy"]; b["sell"] += pm["sell"]; b["delta"] = b["buy"] - b["sell"]
                    b["forming"] = True
                    bars[-1] = b
                else:
                    bars.append({"t": bs, "o": pm["o"], "h": pm["h"], "l": pm["l"], "c": pm["c"], "v": pm["v"], "buy": pm["buy"],
                                 "sell": pm["sell"], "delta": pm["buy"] - pm["sell"], "forming": True, "approx": False})
            elif bars and until < bars[-1]["t"] + tf * 60:
                bars[-1] = dict(bars[-1], forming=True)
        elif not is_live:
            self._bars[key] = bars
            while len(self._bars) > CACHE * 4:
                self._bars.pop(next(iter(self._bars)))
        return bars

    # ---- bars of seconds (5 s, 15 s, 30 s): from the bridge's prints where they are (exact), else from the 1-second
    # bars (o h l c v buyers sellers exact per second, the levels spread over each second's range: approx)
    def _sub_rows(self, root, td, t0, t1, until):
        """(second t, o, h, l, c, v, buy, sell, levels{price ticks: [v, buy, sell]}, exact) per second in [t0, t1)"""
        start, end = session.bounds(td)
        lo, hi = max(t0, start), min(t1, end if until is None else min(end, until))
        if hi <= lo:
            return []
        pr = self.prints(root)
        rows = []
        if pr is not None and pr[0].size and pr[0][0] <= lo:
            t, px, sz, side = pr
            a, b = np.searchsorted(t, lo, "left"), np.searchsorted(t, hi, "left")
            if b > a:
                sec = np.floor(t[a:b]).astype(np.int64)
                px, sz, side = px[a:b], sz[a:b], side[a:b]
                cut = np.flatnonzero(np.r_[True, sec[1:] != sec[:-1]])
                ends = np.r_[cut[1:], sec.size]
                for i, j in zip(cut, ends):
                    lv = {}
                    for p, q, sd in zip(px[i:j].tolist(), sz[i:j].tolist(), side[i:j].tolist()):
                        e = lv.setdefault(int(round(p / TICK)), [0, 0, 0]); e[0] += q; e[1] += q if sd > 0 else 0; e[2] += q if sd < 0 else 0
                    rows.append((int(sec[i]), float(px[i]), float(px[i:j].max()), float(px[i:j].min()), float(px[j - 1]), float(sz[i:j].sum()),
                                 float(sz[i:j][side[i:j] > 0].sum()), float(sz[i:j][side[i:j] < 0].sum()), lv, True))
                return rows
        secs = self.archive.seconds(root, td)
        if secs is None or not secs[0].size:
            return []
        st = secs[0]
        a, b = np.searchsorted(st, lo, "left"), np.searchsorted(st, hi - 1, "right")      # whole seconds only
        for k in range(a, b):
            one = _spread(secs, int(st[k]), int(st[k]) + 1)
            if one is None:
                continue
            rows.append((int(st[k]), one["o"], one["h"], one["l"], one["c"], one["v"], one["buy"], one["sell"],
                         {int(round(p / TICK)): [v, bu, se] for p, v, bu, se in one["levels"]}, False))
        return rows

    def _sub_bars(self, root, tfs, t0, t1, until, with_levels=False):
        out = []
        for td in self._in(root, t0, t1, until):
            start, end = session.bounds(td)
            rows = self._sub_rows(root, td, t0, t1 + tfs, until)
            if not rows:
                continue
            by = {}
            for r in rows:
                bs = start + ((r[0] - start) // tfs) * tfs
                if not t0 <= bs < t1:
                    continue
                b = by.get(bs)
                if b is None:
                    b = by[bs] = {"t": bs, "o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": 0.0, "buy": 0.0, "sell": 0.0, "forming": False, "approx": False, "_lv": {}}
                b["h"] = max(b["h"], r[2]); b["l"] = min(b["l"], r[3]); b["c"] = r[4]
                b["v"] += r[5]; b["buy"] += r[6]; b["sell"] += r[7]
                if not r[9]:
                    b["approx"] = True
                if with_levels:
                    for p, (v, bu, se) in r[8].items():
                        e = b["_lv"].setdefault(p, [0.0, 0.0, 0.0]); e[0] += v; e[1] += bu; e[2] += se
            for bs in sorted(by):
                b = by[bs]
                for k in ("v", "buy", "sell"):
                    b[k] = int(round(b[k]))
                b["delta"] = b["buy"] - b["sell"]
                b["forming"] = until is not None and until < bs + tfs
                lv = b.pop("_lv")
                if with_levels:
                    b["levels"] = [[p * TICK, int(round(v)), int(round(bu)), int(round(se))] for p, (v, bu, se) in sorted(lv.items())]
                out.append(b)
        return out

    def bars(self, root, tf, t0, t1, until=None):
        """bars of tf minutes whose bucket starts in [t0, t1), nothing after `until`; tf below one minute (5 s, 15 s,
        30 s: tf = 1/12, 1/4, 1/2) come from the prints or the seconds"""
        if tf < 1:
            return self._sub_bars(root, int(round(tf * 60)), t0, t1, until)
        out = []
        for td in self._in(root, t0, t1, until):
            out.extend(b for b in self._session_bars(root, td, tf, until) if t0 <= b["t"] < t1)
        return out

    # ---- levels
    def _rows(self, root, t0, t1, until):
        """every level row of the whole minutes in [t0, t1) before `until`, plus the forming minute's: arrays
        (minute t, price in ticks, volume, buy, sell)"""
        ts, ps, vs, bs, ss = [], [], [], [], []
        hi = t1 if until is None else min(t1, until)
        for td in self._in(root, t0, t1, until):
            d = self.minutes(root, td)
            if d is None:
                continue
            if until is not None:
                d = d.until(until)
            mt = d.t[d.lv_i] if d.lv_i.size else np.array([], np.int64)
            sel = (mt >= t0) & (mt < hi)
            ts.append(mt[sel]); ps.append(d.lv_p[sel]); vs.append(d.lv_v[sel]); bs.append(d.lv_buy[sel]); ss.append(d.lv_sell[sel])
        if until is not None and t0 <= int(until // 60) * 60 < t1:
            pm = self.forming(root, until)
            if pm is not None and pm["levels"]:
                ts.append(np.full(len(pm["levels"]), pm["t"], np.int64))
                ps.append(np.array([int(round(p / TICK)) for p, *_ in pm["levels"]], np.int64))
                vs.append(np.array([x[1] for x in pm["levels"]], np.int64))
                bs.append(np.array([x[2] for x in pm["levels"]], np.int64))
                ss.append(np.array([x[3] for x in pm["levels"]], np.int64))
        cat = lambda xs: np.concatenate(xs) if xs else np.array([], np.int64)
        return cat(ts), cat(ps), cat(vs), cat(bs), cat(ss)

    def levels(self, root, tf, t0, t1, until=None):
        """per bar of tf minutes starting in [t0, t1): {bar start: [[price, volume, buy, sell], ...]}"""
        if tf < 1:
            return {b["t"]: b["levels"] for b in self._sub_bars(root, int(round(tf * 60)), t0, t1, until, True) if b["levels"]}
        tds = self._in(root, t0, t1 + tf * 60, until)
        out = {}
        for td in tds:
            start, end = session.bounds(td)
            mt, p, v, b, s = self._rows(root, max(t0, start), min(t1 + tf * 60, end), until)
            if mt.size == 0:
                continue
            bucket = np.array([session.bucket_start(int(t), tf, start) for t in mt.tolist()], np.int64) if tf < 1440 else np.full(mt.size, start, np.int64)
            keep = (bucket >= t0) & (bucket < t1)
            bucket, p, v, b, s = bucket[keep], p[keep], v[keep], b[keep], s[keep]
            if bucket.size == 0:
                continue
            pmin = int(p.min())
            key = (bucket - start) * 1_000_000 + (p - pmin)
            uk, inv = np.unique(key, return_inverse=True)
            sv, sb, ss = np.bincount(inv, v), np.bincount(inv, b), np.bincount(inv, s)
            for k, q, bb, aa in zip(uk.tolist(), sv.tolist(), sb.tolist(), ss.tolist()):
                bt, pk = divmod(k, 1_000_000)
                out.setdefault(int(bt + start), []).append([(pk + pmin) * TICK, int(round(q)), int(round(bb)), int(round(aa))])
        return out

    def profile(self, root, t0, t1, until=None):
        """the volume profile of [t0, t1) up to `until`: levels (price ascending: volume, buy, sell), POC, value area"""
        mt, p, v, b, s = self._rows(root, t0, t1, until)
        if p.size == 0:
            return {"levels": [], "poc": None, "vah": None, "val": None, "total": 0}
        pmin = int(p.min())
        sv = np.bincount(p - pmin, v); sb = np.bincount(p - pmin, b); ss = np.bincount(p - pmin, s)
        idx = np.flatnonzero(sv > 0)
        levels = [[(int(i) + pmin) * TICK, int(round(sv[i])), int(round(sb[i])), int(round(ss[i]))] for i in idx]
        return {"levels": levels, **value_area(levels)}
