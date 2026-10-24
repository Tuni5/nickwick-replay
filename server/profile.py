"""
profile.py - the auction's reference set per session, for the chart's overlays (GET /tl/amt): computed from the
timeline's minutes and levels, cut at the replay clock like everything else.

Per session (trade date):
  rth  09:30-16:00 New York: open, high, low, close, the volume profile (volume and delta per price, POC, value
       area), the TPO profile (30-minute periods A, B, C, ... from 09:30; a period touches the rows between its low
       and high; POC and 70 % value area in TPOs; single prints; tails), the initial balance (the first 60 minutes),
       the VWAP per minute with the volume-weighted standard deviation of the prices around it (the bands)
  on   the overnight 18:00-09:30: open, high, low, close, volume profile
  eth  the whole session (eth=1 only): volume profile, the session VWAP from 18:00
A part the clock has not reached is None; a part the clock stands in is "developing". The regular-hours POC of a
finished session counts as naked until a later minute's range holds it (poc_touched: that minute, or None);
naked=N lists the naked POCs among the N sessions before the window.
"""
import numpy as np

import session
import timeline as TL
from archive import TICK

CACHE = 400
_CACHE = {}                                       # (root, td, row, eth, stamp) -> a finished session's answer


def _vp(p, v, buy, sell):
    """level rows (price in ticks, volume, buy, sell) -> {levels: [[price, volume, delta]], poc, vah, val, total}"""
    if p.size == 0:
        return None
    pmin = int(p.min())
    sv = np.bincount(p - pmin, v)
    sd = np.bincount(p - pmin, buy) - np.bincount(p - pmin, sell)
    idx = np.flatnonzero(sv > 0)
    levels = [[round((int(i) + pmin) * TICK, 2), int(round(sv[i])), int(round(sd[i]))] for i in idx]
    return {"levels": levels, **TL.value_area(levels)}


def _minutes(day, t0, t1, until, forming):
    """(t, high, low, close, open) lists of the minutes in [t0, t1) before the clock, the forming minute appended"""
    w = day.window(t0, t1)
    if until is not None:
        w = w.until(until)
    t, h, l, c, o = w.t.tolist(), w.h.tolist(), w.l.tolist(), w.c.tolist(), w.o.tolist()
    if forming is not None and t0 <= forming["t"] < t1:
        t.append(forming["t"]); h.append(forming["h"]); l.append(forming["l"]); c.append(forming["c"]); o.append(forming["o"])
    return t, h, l, c, o


def tpo(t, h, l, start, row):
    """TPO counts per row of `row` ticks (a row named by its lowest price), periods of 30 minutes from `start`:
    POC, value area (70 % of the TPOs), singles (runs of rows one period touched, inside the range), tails (such
    runs at the top or bottom, two rows or more)"""
    if not t:
        return None
    rp = row * TICK
    per = {}
    for ti, hi, lo in zip(t, h, l):
        k = int((ti - start) // 1800)
        per.setdefault(k, set()).update(range(int(np.floor(lo / rp + 1e-9)), int(np.floor(hi / rp + 1e-9)) + 1))
    count = {}
    for k in per:
        for r in per[k]:
            count[r] = count.get(r, 0) + 1
    rows = sorted(count)
    levels = [[round(r * rp, 2), count[r]] for r in rows]
    va = TL.value_area(levels)
    runs = []
    for r in rows:
        if count[r] == 1:
            if runs and runs[-1][1] == r - 1:
                runs[-1][1] = r
            else:
                runs.append([r, r])
    lo_r, hi_r, n = rows[0], rows[-1], len(rows)
    tails, singles = {"top": None, "bottom": None}, []
    for a, b in runs:
        span = b - a + 1
        if a == lo_r and span >= 2 and n > span:
            tails["bottom"] = [round(a * rp, 2), round((b + 1) * rp, 2)]
        elif b == hi_r and span >= 2 and n > span:
            tails["top"] = [round(a * rp, 2), round((b + 1) * rp, 2)]
        elif a != lo_r and b != hi_r:
            singles.append([round(a * rp, 2), round((b + 1) * rp, 2)])
    return {"row": row, "levels": levels, "periods": len(per), "poc": va["poc"], "vah": va["vah"], "val": va["val"],
            "singles": singles, "tails": tails}


def vwap(rows):
    """level rows (minute t, price in ticks, volume, ...) -> [[minute t, vwap, sd], ...]: the volume-weighted average
    price from the first minute on, per minute, and the volume-weighted standard deviation around it"""
    mt, p, v = rows[0], rows[1], rows[2]
    if mt.size == 0:
        return []
    order = np.argsort(mt, kind="stable")
    mt, p, v = mt[order], p[order], v[order]
    um, inv = np.unique(mt, return_inverse=True)
    px = p * TICK
    cpv, cv, cp2v = np.cumsum(np.bincount(inv, px * v)), np.cumsum(np.bincount(inv, v)), np.cumsum(np.bincount(inv, px * px * v))
    out = []
    for i, t in enumerate(um.tolist()):
        if cv[i] > 0:
            m = cpv[i] / cv[i]
            out.append([int(t), round(float(m), 2), round(float(np.sqrt(max(0.0, cp2v[i] / cv[i] - m * m))), 3)])
    return out


def _part(tl, root, day, t0, t1, until, forming):
    """one stretch of a session: open, high, low, close, volume profile; None before the clock reaches it"""
    if until is not None and until <= t0:
        return None
    t, h, l, c, o = _minutes(day, t0, t1, until, forming)
    if not t:
        return None
    rows = tl._rows(root, t0, t1, until)
    return {"start": t0, "end": t1, "developing": until is not None and until < t1,
            "open": o[0], "high": max(h), "low": min(l), "close": c[-1], "vp": _vp(*rows[1:])}


def session_set(tl, root, td, until=None, row=4, eth=False):
    """the reference set of one session up to the clock, or None if it has no minutes yet"""
    start, end = session.bounds(td)
    if until is not None and until <= start:
        return None
    day = tl.minutes(root, td)
    if day is None:
        return None
    finished = until is None or until >= end
    live = tl.live(root)
    is_live = live is not None and live.t.size and session.trade_date(int(live.t[-1])) == td
    key = (root, td, row, bool(eth), tl._stamp(root, td))
    if finished and not is_live and key in _CACHE:
        return _CACHE[key]
    forming = None
    if not finished:
        forming = tl.forming(root, until)
        if forming is not None and not (start <= forming["t"] < end):
            forming = None
    r0, r1 = session.rth(td)
    out = {"date": td, "start": start, "end": end, "rth": None, "on": None, "eth": None}
    out["on"] = _part(tl, root, day, start, r0, until, forming)
    rth = _part(tl, root, day, r0, r1, until, forming)
    if rth is not None:
        t, h, l, c, o = _minutes(day, r0, r1, until, forming)
        rth["tpo"] = tpo(t, h, l, r0, row)
        ib = [(hi, lo) for ti, hi, lo in zip(t, h, l) if ti < r0 + 3600]
        rth["ib"] = {"high": max(x[0] for x in ib), "low": min(x[1] for x in ib), "end": r0 + 3600,
                     "complete": until is None or until >= r0 + 3600} if ib else None
        rth["vwap"] = vwap(tl._rows(root, r0, r1, until))
    out["rth"] = rth
    if eth:
        out["eth"] = _part(tl, root, day, start, end, until, forming)
        if out["eth"] is not None:
            out["eth"]["vwap"] = vwap(tl._rows(root, start, end, until))
    if finished and not is_live:
        _CACHE[key] = out
        while len(_CACHE) > CACHE:
            _CACHE.pop(next(iter(_CACHE)))
    return out


def _touched(tl, root, price, after, until, dates):
    """the first minute after `after` (up to the clock) whose range holds `price`, else None"""
    for td in dates:
        s, e = session.bounds(td)
        if e <= after or (until is not None and s >= until):
            continue
        day = tl.minutes(root, td)
        if day is None:
            continue
        w = day.window(max(s, after), e)
        if until is not None:
            w = w.until(until)
        hit = np.flatnonzero((w.l <= price + 1e-9) & (w.h >= price - 1e-9))
        if hit.size:
            return int(w.t[hit[0]])
    return None


def window(tl, root, t0, t1, until=None, row=4, eth=False, naked=0):
    """the sessions touching [t0, t1) with their reference sets, whether each regular-hours POC was traded through
    later, and the naked POCs among the `naked` sessions before the window"""
    all_dates = tl.sessions(root)
    hi = t1 if until is None else min(t1, until)
    dates = [d for d in all_dates if session.bounds(d)[1] > t0 and session.bounds(d)[0] < hi]
    out = [s for s in (session_set(tl, root, td, until, row, eth) for td in dates) if s is not None]
    later = [d for d in all_dates if until is None or session.bounds(d)[0] < until]
    for s in out:
        r = s.get("rth")
        if r and r.get("vp") and not r["developing"]:
            r["poc_touched"] = _touched(tl, root, r["vp"]["poc"], r["end"], until, [d for d in later if d > s["date"]])
    nk = []
    if naked:
        first = dates[0] if dates else None
        before = [d for d in all_dates if (first is None or d < first) and (until is None or session.bounds(d)[1] <= until)]
        for td in before[-int(naked):]:
            s = session_set(tl, root, td, until, row, False)
            r = s and s.get("rth")
            if r and r.get("vp") and _touched(tl, root, r["vp"]["poc"], r["end"], until, [d for d in later if d > td]) is None:
                nk.append({"date": td, "poc": r["vp"]["poc"], "since": r["end"]})
    return {"sessions": out, "naked": nk}
