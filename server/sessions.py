"""
sessions.py - named sessions: a container for trades, notes and statistics, as a trading journal keeps them.

A session has a name, an instrument, a start (a moment), an optional end (a date) and a starting balance. Started
in the replay, it is the replay's id in the clock ("s<id>", clock.py), so everything traded is booked under it
(main.py: books "s<id>#<account>", one per trade date) and stays until the session is deleted - unlike the loose
replay ("r…"), whose books "Close Replay" drops. A live session books the paper trades the same way.

The journal lives in the session's file (<logs>/sessions/<id>.json): per trade (keyed by its entry time, exit time
and side) a note, tags, mistakes and a rating; per day a note. stats() reads the session's books, replays each day
with the broker and sums up: the trades with their day, totals, win rate, profit factor, expectancy, the equity
curve, the distribution by hour (New York), weekday, tag and mistake. Nothing is estimated: every figure comes out
of the fills.
"""
import json
import os
import re
import time
from datetime import datetime, timezone

import broker
import session as cme

_ID = re.compile(r"^[a-z0-9]{6,20}$")


class Sessions:
    def __init__(self, folder, book, prints_of):
        self.folder = folder
        self.book = book                               # broker.Book
        self.prints_of = prints_of                     # account -> (Prints, root, first, last, live) (main.py)

    # ---- the files
    def _path(self, sid):
        return os.path.join(self.folder, f"{sid}.json")

    def list(self):
        try:
            names = sorted(os.listdir(self.folder))
        except OSError:
            return []
        out = []
        for n in names:
            if n.endswith(".json"):
                s = self.get(n[:-5])
                if s:
                    out.append(s)
        return sorted(out, key=lambda s: s.get("created", 0), reverse=True)

    def get(self, sid):
        if not _ID.match(sid or ""):
            return None
        try:
            with open(self._path(sid), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _save(self, s):
        os.makedirs(self.folder, exist_ok=True)
        tmp = self._path(s["id"]) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False)
        os.replace(tmp, self._path(s["id"]))

    # ---- create, update, delete
    def create(self, body):
        name = str(body.get("name") or "").strip()[:80]
        inst = str(body.get("inst") or "ES").strip()
        if not name:
            raise ValueError("name: the session's name")
        if not inst.isalnum():
            raise ValueError("inst: a symbol like ES")
        start = float(body.get("start") or 0)
        if not 0 < start < 4e9:
            raise ValueError("start: the moment the session starts (epoch seconds)")
        end = body.get("end")
        end_d = None
        if end not in (None, ""):
            end_d = str(end)[:10]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_d) or cme.bounds(end_d)[1] <= start:
                raise ValueError("end: a date after the start (YYYY-MM-DD)")
        s = {"id": "s" + hex(int(time.time() * 1000))[2:], "name": name, "inst": inst, "start": start, "end": end_d,
             "balance": float(body.get("balance") or 50000), "note": str(body.get("note") or "")[:4000], "created": time.time(),
             "live": bool(body.get("live")), "trades": {}, "days": {}, "tags": []}
        self._save(s)
        return s

    def update(self, sid, body):
        s = self.get(sid)
        if not s:
            raise KeyError("no such session")
        for k in ("name", "note"):
            if k in body:
                s[k] = str(body[k] or "").strip()[:4000 if k == "note" else 80]
        if "balance" in body:
            s["balance"] = float(body["balance"] or 0)
        if "end" in body:
            e = body["end"]
            if e in (None, ""):
                s["end"] = None
            else:
                e = str(e)[:10]
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", e) or cme.bounds(e)[1] <= s["start"]:
                    raise ValueError("end: a date after the start")
                s["end"] = e
        if "tags" in body and isinstance(body["tags"], list):
            s["tags"] = sorted({str(t).strip()[:40] for t in body["tags"] if str(t).strip()})
        self._save(s)
        return s

    def delete(self, sid):
        s = self.get(sid)
        if not s:
            raise KeyError("no such session")
        self.book.drop(f"{sid}#")
        try:
            os.remove(self._path(sid))
        except OSError:
            pass
        return {"id": sid, "deleted": True}

    # ---- the journal
    @staticmethod
    def trade_key(tr):
        return f"{tr['t_in']:.3f}|{tr['t_out']:.3f}|{tr['side']}"

    def journal_trade(self, sid, key, body):
        s = self.get(sid)
        if not s:
            raise KeyError("no such session")
        if not re.fullmatch(r"[0-9.]+\|[0-9.]+\|(long|short)", str(key or "")):
            raise ValueError("trade: the trade's key")
        e = s["trades"].get(key, {})
        if "note" in body:
            e["note"] = str(body["note"] or "")[:4000]
        for k in ("tags", "mistakes"):
            if k in body and isinstance(body[k], list):
                e[k] = [str(t).strip()[:40] for t in body[k] if str(t).strip()][:20]
                for t in e[k]:
                    if t not in s["tags"]:
                        s["tags"].append(t)
        if "rating" in body:
            r = body["rating"]
            e["rating"] = None if r in (None, "", 0) else max(1, min(5, int(r)))
        s["trades"][key] = e
        self._save(s)
        return e

    def journal_day(self, sid, day, body):
        s = self.get(sid)
        if not s:
            raise KeyError("no such session")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day or "")):
            raise ValueError("day: YYYY-MM-DD")
        e = s["days"].get(day, {})
        if "note" in body:
            e["note"] = str(body["note"] or "")[:4000]
        s["days"][day] = e
        self._save(s)
        return e

    # ---- the statistics, out of the fills
    def stats(self, sid):
        s = self.get(sid)
        if not s:
            raise KeyError("no such session")
        trades, by_day = [], {}
        for name in self.book.names(f"{sid}#"):
            parts = name.split("#")
            account = parts[1]
            try:
                pr, root, first, last, is_live = self.prints_of(account)
            except ValueError:
                continue
            until = time.time() if is_live else float(pr.t[-1]) + 1
            st = broker.compute(self.book.actions(name), pr, until, root)
            day = parts[2] if is_live and len(parts) > 2 else cme.trade_date(first + 3600)
            for tr in st["trades"]:
                tr = dict(tr, day=day, key=self.trade_key(tr))
                j = s["trades"].get(tr["key"], {})
                tr["note"], tr["tags"], tr["mistakes"], tr["rating"] = j.get("note", ""), j.get("tags", []), j.get("mistakes", []), j.get("rating")
                trades.append(tr)
            d = by_day.setdefault(day, {"day": day, "usd": 0.0, "trades": 0, "wins": 0, "volume": 0.0, "note": s["days"].get(day, {}).get("note", "")})
            d["usd"] = round(d["usd"] + st["realized_usd"], 2); d["trades"] += len(st["trades"])
            d["wins"] += sum(1 for t in st["trades"] if t["usd"] > 0); d["volume"] += sum(t["qty"] for t in st["trades"])
        trades.sort(key=lambda t: t["t_in"])
        wins = [t for t in trades if t["usd"] > 0]; losses = [t for t in trades if t["usd"] < 0]
        gw, gl = sum(t["usd"] for t in wins), -sum(t["usd"] for t in losses)
        n = len(trades)
        equity, acc = [], s["balance"]
        for t in trades:
            acc = round(acc + t["usd"], 2); equity.append([t["t_out"], acc])
        def bucket(key_of):
            out = {}
            for t in trades:
                for k in key_of(t):
                    b = out.setdefault(k, {"key": k, "trades": 0, "wins": 0, "usd": 0.0})
                    b["trades"] += 1; b["wins"] += 1 if t["usd"] > 0 else 0; b["usd"] = round(b["usd"] + t["usd"], 2)
            return sorted(out.values(), key=lambda b: str(b["key"]))
        ny_hour = lambda t: int((cme.ny_wall(t["t_in"]) % 86400) // 3600)
        weekday = lambda t: datetime.fromtimestamp(cme.ny_wall(t["t_in"]), timezone.utc).strftime("%a")
        totals = {"trades": n, "wins": len(wins), "losses": len(losses), "flat": n - len(wins) - len(losses),
                  "win_rate": round(len(wins) / n * 100, 1) if n else None, "usd": round(gw - gl, 2),
                  "profit_factor": round(gw / gl, 2) if gl else (None if not gw else float("inf")),
                  "expectancy": round((gw - gl) / n, 2) if n else None,
                  "avg_win": round(gw / len(wins), 2) if wins else None, "avg_loss": round(-gl / len(losses), 2) if losses else None,
                  "largest_win": max((t["usd"] for t in wins), default=None), "largest_loss": min((t["usd"] for t in losses), default=None),
                  "days": len(by_day), "green_days": sum(1 for d in by_day.values() if d["usd"] > 0),
                  "balance": s["balance"], "equity": round(s["balance"] + gw - gl, 2),
                  "max_drawdown": _drawdown([s["balance"]] + [e[1] for e in equity])}
        if totals["profit_factor"] == float("inf"):
            totals["profit_factor"] = None
        return {**s, "trades_list": trades, "days_list": sorted(by_day.values(), key=lambda d: d["day"]), "totals": totals, "equity": equity,
                "by_hour": bucket(lambda t: [ny_hour(t)]), "by_weekday": bucket(lambda t: [weekday(t)]),
                "by_tag": bucket(lambda t: t["tags"] or ["(kein Tag)"]), "by_mistake": bucket(lambda t: t["mistakes"]),
                "by_exit": bucket(lambda t: [t["exit_by"]])}


def _drawdown(curve):
    peak, dd = curve[0], 0.0
    for v in curve:
        peak = max(peak, v); dd = max(dd, peak - v)
    return round(dd, 2)
