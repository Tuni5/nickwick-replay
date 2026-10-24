"""profile.py against the real day: RTH / overnight profiles, TPO, initial balance, VWAP - all from reference.py"""
import math

import profile as P
import reference as R
import session
from conftest import DAY

START, END = session.bounds(DAY)
R0, R1 = session.rth(DAY)


def tpo_reference(mins, r0, r1, row=4):
    """per 30-minute period the rows its minutes' ranges touched; counts per row"""
    rp = row * 0.25
    per = {}
    for t, m in mins.items():
        if r0 <= t < r1:
            k = (t - r0) // 1800
            lo, hi = math.floor(m["l"] / rp + 1e-9), math.floor(m["h"] / rp + 1e-9)
            per.setdefault(k, set()).update(range(lo, hi + 1))
    count = {}
    for rows in per.values():
        for r in rows:
            count[r] = count.get(r, 0) + 1
    return {round(r * rp, 2): n for r, n in count.items()}, len(per)


def test_rth_and_overnight(tl):
    mins = R.minutes(DAY)
    s = P.session_set(tl, "ES", DAY)
    rth, on = s["rth"], s["on"]
    inside = {t: m for t, m in mins.items() if R0 <= t < R1}
    assert (rth["open"], rth["high"], rth["low"], rth["close"]) == (7863.25, 7870.0, 7846.25, 7856.5)      # by hand
    assert rth["high"] == max(m["h"] for m in inside.values()) and rth["low"] == min(m["l"] for m in inside.values())
    rows = R.levels_of(mins, R0, R1)
    want = R.profile(rows)
    assert (rth["vp"]["poc"], rth["vp"]["vah"], rth["vp"]["val"], rth["vp"]["total"]) == (want["poc"], want["vah"], want["val"], want["total"])
    assert {p: v for p, v, _ in rth["vp"]["levels"]} == rows
    delta = {}
    for t, m in inside.items():
        for p, (v, b, sl) in m["levels"].items():
            delta[p] = delta.get(p, 0) + b - sl
    assert {p: d for p, _, d in rth["vp"]["levels"]} == delta
    assert sum(d for _, _, d in rth["vp"]["levels"]) == sum(m["buy"] - m["sell"] for m in inside.values()) == -7376
    night = {t: m for t, m in mins.items() if START <= t < R0}
    assert on["high"] == max(m["h"] for m in night.values()) and on["low"] == min(m["l"] for m in night.values())
    assert on["vp"]["total"] == sum(m["v"] for m in night.values())
    assert not rth["developing"] and not on["developing"] and s["eth"] is None


def test_tpo_initial_balance_and_vwap(tl):
    mins = R.minutes(DAY)
    rth = P.session_set(tl, "ES", DAY)["rth"]
    counts, periods = tpo_reference(mins, R0, R1)
    assert {p: n for p, n in rth["tpo"]["levels"]} == counts and rth["tpo"]["periods"] == periods == 13
    assert rth["tpo"]["val"] <= rth["tpo"]["poc"] <= rth["tpo"]["vah"]
    ib = {t: m for t, m in mins.items() if R0 <= t < R0 + 3600}
    assert rth["ib"] == {"high": max(m["h"] for m in ib.values()), "low": min(m["l"] for m in ib.values()), "end": R0 + 3600, "complete": True}
    v = rth["vwap"]
    assert len(v) == 390 and v[0][0] == R0 and v[-1][0] == R1 - 60
    rows = R.levels_of(mins, R0, R1)
    assert abs(v[-1][1] - R.vwap(rows)) < 0.005
    mean = R.vwap(rows)
    sd = math.sqrt(sum(vol * (p - mean) ** 2 for p, vol in rows.items()) / sum(rows.values()))
    assert abs(v[-1][2] - sd) < 0.002
    first = R.levels_of(mins, R0, R0 + 60)
    assert abs(v[0][1] - R.vwap(first)) < 0.005


def test_developing_at_the_clock(tl):
    mins, secs = R.minutes(DAY), R.seconds(DAY)
    until = R0 + 47 * 60 + 20
    s = P.session_set(tl, "ES", DAY, until, eth=True)
    rth = s["rth"]
    assert rth["developing"] and not rth["ib"]["complete"]
    ib = {t: m for t, m in mins.items() if R0 <= t < R0 + 46 * 60}
    f = R.forming(secs, R0 + 47 * 60, until)
    assert rth["ib"]["high"] == max([m["h"] for m in ib.values()] + [f["h"]])
    rows = R.levels_of(mins, R0, R1, until)
    assert rth["vp"]["total"] == sum(rows.values()) + f["v"]
    assert rth["vwap"][-1][0] == R0 + 47 * 60 and len(rth["vwap"]) == 48
    assert s["eth"]["developing"] and s["eth"]["vwap"][0][0] == START
    assert P.session_set(tl, "ES", DAY, START - 10) is None
    w = P.window(tl, "ES", 0, 4e9, until, naked=5)
    assert len(w["sessions"]) == 1 and w["naked"] == [] and "poc_touched" not in w["sessions"][0]["rth"]
    w = P.window(tl, "ES", 0, 4e9)
    assert w["sessions"][0]["rth"]["poc_touched"] is None or w["sessions"][0]["rth"]["poc_touched"] > R1
