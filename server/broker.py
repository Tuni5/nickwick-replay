"""
broker.py - the simulated broker: orders filled against the real prints of a trading day, up to the replay clock and
never beyond it.

The account is a pure function of what the user did and the prints: compute(actions, prints, until). Every action
carries the replay time it was given at and acts on the prints after that moment. Nothing is stored but the list of
actions (Book, logs/broker/<account>.json), so playing on, jumping back and playing again always show the account as
it was at that moment. Acting after a jump back drops the actions that lay later (a new branch; the answer says how
many).

The prints (trades with their aggressor side, +1 buyer, -1 seller, 0 unknown):
  the tick export      every trade of the day, when the bridge exported it (archive.ticks)
  the 1-second bars    else a path per second in tick steps: open, then the low and the high (low first when the
                       second closed up, high first when it closed down), then the close; up-steps count as buyers,
                       down-steps as sellers, the open as unknown; the second's volume spread over the steps. An
                       assumption about the order inside a second - the panel says so (prints_from_seconds)
  live                 the prints the bridge sends (live.py)
Fills:
  market buy     the next print a buyer lifted (or of unknown side) - at its price; sell: the next one a seller hit
  limit buy L    resting below the market: when a print trades THROUGH it (price < L, the print before at or above
                 L): at L; a buyer lifting at or below L: at that print's price. Placed when the market already lay
                 below L (marketable): at the next print. Sell mirrored. A print exactly at L does not fill a resting
                 limit.
  stop buy S     the first print at or above S - at that print's price (slippage included); sell mirrored
  bracket        stop-loss and target on the position: a stop and a limit for its whole size, one cancels the other,
                 both go when the position is flat, they follow its size
  attached       an order may carry sl / tp: when it fills and the position then lies on its side (opened or added),
                 they become the position's bracket; an order that only reduces or closes leaves the bracket alone
  modify         a working limit or stop at a new price; its attached sl / tp moved or removed (None)
  flatten        cancels everything, closes the position at market
One order fills completely on one print. Searching is numpy over the prints from the current moment on.
Quantities are contracts in steps of 0.1 (a tenth of an ES behaves like one MES: the micro contracts are traded as
fractions of the big one, with the big one's prints).
"""
import json
import os
import time

import numpy as np

import specs as _specs

TYPES = ("market", "limit", "stop")


def specs(root):
    """(tick size, dollars per point) of a symbol (specs.py)"""
    sp = _specs.spec(root)
    return sp[0], sp[1]


class Prints:
    """the prints as arrays: t (epoch seconds), px, sz, side (+1 buyer, -1 seller, 0 unknown)"""

    def __init__(self, t, px, sz, side, source):
        self.t, self.px, self.sz, self.side, self.source = t, px, sz, side, source

    @staticmethod
    def from_seconds(secs, tick):
        """(t, o, h, l, c, v, buy, sell) arrays of 1-second bars -> the path described above"""
        ts, px, sz, sd = [], [], [], []
        st, so, sh, sl, sc, sv = secs[0], secs[1], secs[2], secs[3], secs[4], secs[5]
        for k in range(st.size):
            o, h, l, c, v = float(so[k]), float(sh[k]), float(sl[k]), float(sc[k]), float(sv[k])
            stops = [o, l, h, c] if c >= o else [o, h, l, c]
            path = [o]
            for a, b in zip(stops, stops[1:]):
                n = int(round(abs(b - a) / tick))
                step = tick if b > a else -tick
                path.extend(a + step * i for i in range(1, n + 1))
            n = len(path)
            each = v / n
            for i, p in enumerate(path):
                ts.append(st[k] + i / n); px.append(round(p / tick) * tick); sz.append(each)
                sd.append(0 if i == 0 else (1 if p > path[i - 1] else -1))
        return Prints(np.array(ts, np.float64), np.array(px, np.float64), np.array(sz, np.float32), np.array(sd, np.int8),
                      "the 1-second bars: a path per second, the order inside a second assumed")

    @staticmethod
    def from_export(ticks):
        t, px, sz, side = ticks
        return Prints(t, px, sz, side, "the bridge's tick export: every trade")


def _first(pr, lo, hi, order):
    """the index of the first print in [lo, hi) that fills the order, and its fill price - or (None, None)"""
    if lo >= hi:
        return None, None
    px, sd = pr.px[lo:hi], pr.side[lo:hi]
    side, kind, p = order["side"], order["type"], order.get("price")
    marketable = None
    if kind == "market":
        cond = (sd >= 0) if side > 0 else (sd <= 0)
    elif kind == "limit":
        through = px < p if side > 0 else px > p
        marketable = (sd > 0) & (px <= p) if side > 0 else (sd < 0) & (px >= p)
        cond = through | marketable
    else:
        cond = px >= p if side > 0 else px <= p
    if not cond.any():
        return None, None
    i = int(np.argmax(cond))
    if kind == "limit" and not marketable[i]:
        # traded through: a resting limit (the print before was at or beyond it) fills at its price; a limit placed
        # when the market already lay beyond it is marketable and fills at the print
        prev = float(pr.px[lo + i - 1]) if lo + i > 0 else None
        resting = prev is None or (prev >= p if side > 0 else prev <= p)
        return lo + i, p if resting else float(px[i])
    return lo + i, float(px[i])


def compute(actions, pr, until, root="ES"):
    """the account at `until`: position, average price, open and realised P/L, working orders, the bracket, fills
    and closed trades"""
    tick, point = specs(root)
    acts = sorted((a for a in actions if a["t"] <= until), key=lambda a: (a["t"], a.get("seq", 0)))
    working, bracket = [], {"sl": None, "tp": None}
    state = {"pos": 0, "avg": 0.0, "realized": 0.0, "since": None}
    fills, trades = [], []

    def sync_bracket():
        working[:] = [o for o in working if o.get("role") not in ("sl", "tp")]
        pos = state["pos"]
        if pos == 0:
            bracket["sl"] = bracket["tp"] = None
            return
        side = -1 if pos > 0 else 1
        if bracket["sl"] is not None:
            working.append({"id": "sl", "role": "sl", "side": side, "type": "stop", "price": bracket["sl"], "qty": q1(abs(pos))})
        if bracket["tp"] is not None:
            working.append({"id": "tp", "role": "tp", "side": side, "type": "limit", "price": bracket["tp"], "qty": q1(abs(pos))})

    q1 = lambda x: round(x + 0.0, 1)                               # quantities in tenths, no float drift

    def fill(order, i, price):
        qty, side, t = q1(order["qty"]), order["side"], float(pr.t[i])
        fills.append({"t": t, "id": order["id"], "side": side, "qty": qty, "price": price, "type": order["type"], "role": order.get("role")})
        pos, avg = state["pos"], state["avg"]
        signed = side * qty
        if pos == 0 or (pos > 0) == (signed > 0):              # opening or adding
            if pos == 0:
                state["since"] = t
            state["avg"] = (avg * abs(pos) + price * qty) / (abs(pos) + qty)
            state["pos"] = q1(pos + signed)
        else:                                                  # reducing, closing or flipping
            closing = q1(min(qty, abs(pos)))
            pnl = (price - avg) * closing * (1 if pos > 0 else -1)
            state["realized"] += pnl
            trades.append({"side": "long" if pos > 0 else "short", "qty": closing, "entry": avg, "exit": price,
                           "t_in": state["since"], "t_out": t, "points": pnl / closing, "ticks": round(pnl / closing / tick, 2),
                           "usd": round(pnl * point, 2), "exit_by": order.get("role") or order["type"]})
            rest = q1(qty - closing)
            pos = q1(pos + (1 if signed > 0 else -1) * closing)
            if pos == 0:
                avg, state["since"] = 0.0, None
            if rest:                                           # flipped: the rest opens the other way
                pos, avg, state["since"] = (1 if signed > 0 else -1) * rest, price, t
            state["pos"], state["avg"] = pos, avg
        if order.get("role") in ("sl", "tp"):                  # one cancels the other
            bracket["sl"] = bracket["tp"] = None
        elif not order.get("role") and state["pos"] and (state["pos"] > 0) == (side > 0):
            for k in ("sl", "tp"):                             # attached: now the position's
                if order.get(k) is not None:
                    bracket[k] = order[k]
        sync_bracket()

    def run(lo, hi):
        """fill what fills among the prints [lo, hi), in time order"""
        while working:
            best = None
            for o in working:
                i, price = _first(pr, lo, hi, o)
                if i is not None and (best is None or i < best[0]):
                    best = (i, price, o)
            if best is None:
                break
            i, price, o = best
            working.remove(o)
            fill(o, i, price)
            lo = i                                             # other orders may fill on the same print

    lo = 0
    for a in acts:
        hi = int(np.searchsorted(pr.t, a["t"], "right"))       # the prints up to the action's moment
        run(lo, hi)
        lo = hi
        op = a["op"]
        if op == "order":
            o = {"id": a["id"], "side": a["side"], "type": a["type"], "price": a.get("price"), "qty": a["qty"], "t": a["t"]}
            for k in ("sl", "tp"):
                if a.get(k) is not None:
                    o[k] = a[k]
            working.append(o)
        elif op == "modify":
            for o in working:
                if o["id"] == a["id"] and not o.get("role"):
                    if a.get("price") is not None and o["type"] != "market":
                        o["price"] = a["price"]
                    for k in ("sl", "tp"):
                        if k in a:
                            if a[k] is None:
                                o.pop(k, None)
                            else:
                                o[k] = a[k]
        elif op == "cancel":
            working[:] = [o for o in working if o["id"] != a["id"]]
            if a["id"] in ("sl", "tp"):
                bracket[a["id"]] = None
        elif op == "cancel_all":
            working[:] = []
            bracket["sl"] = bracket["tp"] = None
        elif op == "bracket":
            for k in ("sl", "tp"):
                if k in a:
                    bracket[k] = a[k]
            sync_bracket()
        elif op == "flatten":
            working[:] = []
            bracket["sl"] = bracket["tp"] = None
            if state["pos"]:
                working.append({"id": f"flat{a.get('seq', 0)}", "side": -1 if state["pos"] > 0 else 1, "type": "market",
                                "qty": q1(abs(state["pos"])), "t": a["t"], "role": "flatten"})
    hi = int(np.searchsorted(pr.t, until, "right"))
    run(lo, hi)
    pos, avg = state["pos"], state["avg"]
    last = float(pr.px[hi - 1]) if hi > 0 else None
    open_pts = (last - avg) * pos if pos and last is not None else 0.0
    return {"until": until, "last": last, "tick_size": tick, "point_value": point, "pos": pos, "avg": avg if pos else None,
            "open_ticks": round(open_pts / abs(pos) / tick, 2) if pos else 0, "open_usd": round(open_pts * point, 2),
            "realized_usd": round(state["realized"] * point, 2), "orders": [_public(o) for o in working],
            "bracket": dict(bracket), "fills": fills[-50:], "trades": trades, "prints_from": pr.source}


def _public(o):
    return {k: o[k] for k in ("id", "side", "type", "price", "qty", "role", "sl", "tp", "t") if k in o}


class Book:
    """the actions per account, kept in <folder>/<account>.json so a restart keeps them"""

    def __init__(self, folder):
        self.folder = folder
        self._acts = {}

    def _path(self, account):
        return os.path.join(self.folder, f"{self._safe(account)}.json")

    def actions(self, account):
        if account not in self._acts:
            try:
                with open(self._path(account), encoding="utf-8") as f:
                    self._acts[account] = json.load(f)
            except (OSError, ValueError):
                self._acts[account] = []
        return self._acts[account]

    def add(self, account, action):
        """append an action at its moment; actions later than it are dropped (a new branch). Returns how many.
        Two windows' clocks differ by their latency: an action that lands less than two seconds behind the last one
        is a later action with a slightly early stamp, not a jump back - it goes after the last one."""
        acts = self.actions(account)
        last = max((a["t"] for a in acts), default=None)
        if last is not None and action["t"] < last < action["t"] + 2:
            action["t"] = last + 0.001
        keep = [a for a in acts if a["t"] <= action["t"]]
        dropped = len(acts) - len(keep)
        action["seq"] = max((a.get("seq", 0) for a in keep), default=0) + 1
        keep.append(action)
        self._acts[account] = keep
        self._save(account)
        return dropped

    def reset(self, account):
        self._acts[account] = []
        self._save(account)

    def names(self, prefix=""):
        """the accounts on disk whose name starts with prefix"""
        try:
            files = os.listdir(self.folder)
        except OSError:
            return []
        out = []
        for f in files:
            if f.endswith(".json") and f.startswith(self._safe(prefix)):
                out.append(f[:-5])
        return sorted(out)

    def drop(self, prefix):
        """delete every account whose name starts with prefix (Close Replay); returns how many"""
        n = 0
        for name in self.names(prefix):
            self._acts.pop(name, None)
            try:
                os.remove(os.path.join(self.folder, name + ".json")); n += 1
            except OSError:
                pass
        return n

    @staticmethod
    def _safe(name):
        return "".join(ch if ch.isalnum() or ch in "@-_.#" else "_" for ch in name)

    def _save(self, account):
        os.makedirs(self.folder, exist_ok=True)
        tmp = self._path(account) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._acts[account], f)
        os.replace(tmp, self._path(account))


def new_id():
    return f"o{int(time.time() * 1000) % 10**9}"
