"""
reference.py - the ground truth for the tests, computed the dumb way straight from the Rithmic Bridge's files with the
csv module and plain loops. Shares no code with the server: what the server returns has to equal this, number by
number. The real day tests/data/ES/2026-10-12 is the user's own archive day.

  minutes(day)             {minute epoch: {o, h, l, c, v, buy, sell, levels: {price: [v, buy, sell]}}}, from the
                           1m bars and the levels file
  seconds(day)             [(epoch, o, h, l, c, v, buy, sell)] from the 1-second file (seconds with trades only)
  bars(mins, tf, start)    bars of tf minutes, buckets anchored at the session start: {bucket: {o,h,l,c,v,buy,sell}}
  forming(secs, t0, until) what there is of minute t0 from its seconds before `until`: o h l c v buy sell
  profile(rows)            POC and the 70 % value area of {price: volume}
  vwap(rows)               volume-weighted average price of {price: volume}
"""
import csv
import json
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TICK = 0.25


def epoch(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def meta(day, root="ES"):
    with open(os.path.join(DATA, "1m-bars", root, f"{day}.meta.json")) as f:
        return json.load(f)


def minutes(day, root="ES"):
    out = {}
    with open(os.path.join(DATA, "1m-bars", root, f"{day}_bars.csv"), newline="") as f:
        for r in csv.DictReader(f):
            out[epoch(r["minute_utc"])] = {"o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]), "c": float(r["close"]),
                                           "v": int(r["volume"]), "buy": int(r["buy_aggr"]), "sell": int(r["sell_aggr"]), "levels": {}}
    with open(os.path.join(DATA, "1m-bars", root, f"{day}_levels.csv"), newline="") as f:
        for r in csv.DictReader(f):
            m = out[epoch(r["minute_utc"])]
            p = float(r["price"])
            e = m["levels"].setdefault(p, [0, 0, 0])
            e[0] += int(r["volume"]); e[1] += int(r["buy_aggr"]); e[2] += int(r["sell_aggr"])
    return out


def seconds(day, root="ES"):
    out = []
    with open(os.path.join(DATA, "1s-bars", root, f"{day}_1s.csv"), newline="") as f:
        for r in csv.DictReader(f):
            out.append((epoch(r["second_utc"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                        int(r["volume"]), int(r["buy_aggr"]), int(r["sell_aggr"])))
    return sorted(out)


def bars(mins, tf, start, until=None):
    """whole minutes only (a minute counts when it ended at or before `until`), summed per bucket of tf minutes
    anchored at `start` (the session start); the bucket's time is its start"""
    out = {}
    for t in sorted(mins):
        if until is not None and t + 60 > until:
            continue
        m = mins[t]
        k = start + ((t - start) // (tf * 60)) * tf * 60
        b = out.get(k)
        if b is None:
            out[k] = {"o": m["o"], "h": m["h"], "l": m["l"], "c": m["c"], "v": m["v"], "buy": m["buy"], "sell": m["sell"], "levels": {}}
            b = out[k]
        else:
            b["h"] = max(b["h"], m["h"]); b["l"] = min(b["l"], m["l"]); b["c"] = m["c"]
            b["v"] += m["v"]; b["buy"] += m["buy"]; b["sell"] += m["sell"]
        for p, (v, bu, se) in m["levels"].items():
            e = b["levels"].setdefault(p, [0, 0, 0]); e[0] += v; e[1] += bu; e[2] += se
    return out


def forming(secs, t0, until):
    """the seconds of minute t0 that lie before `until`, summed: None when there are none"""
    rows = [s for s in secs if t0 <= s[0] < until and s[0] < t0 + 60]
    if not rows:
        return None
    return {"o": rows[0][1], "h": max(r[2] for r in rows), "l": min(r[3] for r in rows), "c": rows[-1][4],
            "v": sum(r[5] for r in rows), "buy": sum(r[6] for r in rows), "sell": sum(r[7] for r in rows)}


def profile(rows):
    """rows: {price: volume} -> poc, vah, val, total. The value area: start at the POC, add the larger of the two
    neighbouring levels (upper on a tie) until 70 % of the volume is inside. Equal maxima: the lowest price is the POC."""
    prices = sorted(rows)
    vols = [rows[p] for p in prices]
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
    return {"poc": prices[i], "vah": prices[hi], "val": prices[lo], "total": total}


def vwap(rows):
    tot = sum(rows.values())
    return sum(p * v for p, v in rows.items()) / tot if tot else None


def levels_of(mins, t0, t1, until=None):
    """{price: volume} of the whole minutes in [t0, t1) that ended at or before until"""
    out = {}
    for t, m in mins.items():
        if t0 <= t < t1 and (until is None or t + 60 <= until):
            for p, (v, _, _) in m["levels"].items():
                out[p] = out.get(p, 0) + v
    return out
