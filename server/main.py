"""
main.py - the replay's server: one process that reads the Rithmic Bridge's archive, takes its live data, keeps the
replay clock and the simulated broker, and serves the page.

  python server/main.py                       # http://127.0.0.1:8021/   (settings: replay.cfg, the settings page)

  GET  /                        the replay (web/index.html); first start (no replay.cfg yet): the settings page
  GET  /config.html             settings: folders, what the archive holds and what does not add up in it, live data
  GET  /tl/sessions?inst                     the trade dates of an instrument (archive + live) and the instruments
  GET  /tl/bars?inst&tf&from&to&until        bars of any timeframe (tf in minutes; 5, 15, 30 seconds as 1/12, 1/4,
                                             1/2 of a minute), cut at the clock (timeline.py)
  GET  /tl/levels?inst&tf&from&to&until      volume per price and bar: buy (at the ask), sell (at the bid)
  GET  /tl/profile?inst&from&to&until        the volume profile of a range, POC, value area
  GET  /tl/amt?inst&from&to&until[&row][&naked][&eth]   per session: profiles, TPO, IB, VWAP (profile.py)
  GET  /feeds                   the live feeds
  GET  /health                  "ok"
  POST /ingest                  from the Rithmic Bridge (live.py)
  GET/POST /api/sessions        named sessions with their journal and statistics (sessions.py)
  GET/POST /api/workspaces      workspaces: a chart layout and the drawings per instrument (workspaces.py)
  GET/POST /api/...             settings, inventory, data checks, the clock, the broker, snapshots - every POST needs
                                X-Replay-Token, a random value of this run written only into the pages the server
                                serves; every /api request must name this server as Host (no DNS rebinding). With
                                LAN=1 in replay.cfg the server listens on every address of the machine, so the page
                                works on an iPad or phone in the home network.
"""
import base64
import json
import os
import re
import secrets
import socket
import sys
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import archive
import broker
import clock
import live
import profile as prof
import session
import sessions as sess
import settings
import specs
import timeline
import workspaces

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), "web")
LOGS = os.environ.get("REPLAY_LOGS") or os.path.join(os.path.dirname(HERE), "logs")
TOKEN = secrets.token_urlsafe(24)
TOKEN_PAGES = ("index.html", "config.html")
ACCOUNT = re.compile(r"^([A-Za-z0-9]+)\.1m@(\d{4}-\d{2}-\d{2})$")          # an archive day's account: ES.1m@2026-10-12

FEEDS = live.Feeds(os.path.join(LOGS, "prints"), os.path.join(LOGS, "live"))
BOOK = broker.Book(os.path.join(LOGS, "broker"))
SESSIONS = None                                                             # sessions.Sessions, after prints_of exists
WORKSPACES = workspaces.Workspaces(os.path.join(LOGS, "workspaces"))
STATE = {"archive": None, "tl": None, "eff": None}
_PRINTS = {}                                                                 # (root, td, stamp) -> Prints of an archive day


def apply_settings():
    """take replay.cfg into the process: at start and after the settings page saved"""
    eff = settings.resolve()
    if STATE["eff"] is None or STATE["eff"]["DATA_DIR"] != eff["DATA_DIR"]:
        STATE["archive"] = archive.Archive(eff["DATA_DIR"])
        STATE["tl"] = timeline.Timeline(STATE["archive"], FEEDS.day, FEEDS.prints_of)
        _PRINTS.clear()
    live.STALE_S, live.EXPIRE_S = eff["STALE"], eff["EXPIRE"]
    STATE["eff"] = eff
    return eff


def tl():
    return STATE["tl"]


# ---------------------------------------------------------------- the broker's prints
def prints_of(account):
    """(Prints, root, first, last, live) of an account: an archive day (ES.1m@<date>) or a live feed's source id"""
    m = ACCOUNT.match(account or "")
    if m:
        root, td = m.group(1), m.group(2)
        a = STATE["archive"]
        day = a.day(root, td)
        if day is None:
            raise ValueError(f"no archive day {td} for {root}")
        key = (root, td, day.stamp)
        if key not in _PRINTS:
            _PRINTS.clear()
            tick, _ = broker.specs(root)
            ex = a.ticks(root, td)
            if ex is not None:
                pr = broker.Prints.from_export(ex)
            else:
                secs = a.seconds(root, td)
                if secs is None or not secs[0].size:
                    raise ValueError(f"{td}: no tick export and no 1-second bars - orders cannot fill on this day")
                pr = broker.Prints.from_seconds(secs, tick)
            _PRINTS[key] = pr
        pr = _PRINTS[key]
        return pr, root, float(pr.t[0]), float(pr.t[-1]), False
    got = FEEDS.prints(account)
    if got is None:
        raise ValueError("orders need prints: an archive day (ES.1m@<trade date>) or a live feed that sends its trades")
    f, store = got
    s, n = store.start, store.n
    pr = broker.Prints(store.t[s:n], store.px[s:n], store.sz[s:n], store.side[s:n], "the live prints")
    return pr, archive.root_of(f["instrument"]), float(pr.t[0]), float(pr.t[-1]), True


def session_totals(replay, root, book):
    """what the replay's other days booked (the account of a replay spans its days: fills per day, realised P/L and
    the trades summed over the days)"""
    realized, trades = 0.0, []
    for name in BOOK.names(f"{replay}#"):
        if name == book:
            continue
        m = ACCOUNT.match(name.split("#", 1)[1])
        if not m or m.group(1) != root:
            continue
        try:
            pr, *_ = prints_of(m.group(0))
        except ValueError:
            continue
        st = broker.compute(BOOK.actions(name), pr, float(pr.t[-1]) + 1, root)
        realized += st["realized_usd"]; trades.extend(st["trades"])
    return realized, trades


def broker_call(method, op, body, q):
    account = str(body.get("feed") or q.get("feed") or "")
    replay = str(body.get("session") or q.get("session") or "")                 # the replay running (clock.py): r… loose, s… a session
    if op == "close":                                                          # Close Replay: a loose replay's accounts go, a session's stay
        if not re.fullmatch(r"[rs][0-9a-f]{6,20}", replay):
            raise ValueError("session: the replay's id")
        return {"session": replay, "dropped": BOOK.drop(f"{replay}#") if replay.startswith("r") else 0}
    pr, root, start, end, is_live = prints_of(account)
    tick, _ = broker.specs(root)
    td_live = session.trade_date(time.time())
    book = (f"{replay}#{account}#{td_live}" if replay else f"{account}#{td_live}") if is_live else (f"{replay}#{account}" if replay else account)
    if replay.startswith("s") and method == "POST" and op != "reset":          # a session's window: its start, its end
        sx = SESSIONS.get(replay)
        if sx is None:
            raise ValueError("the session no longer exists")
        tt = time.time() if is_live else float(body.get("t") or 0)
        if tt < sx["start"] - 1 or (sx["end"] and tt > session.bounds(sx["end"])[1]):
            raise ValueError("outside the session: it runs from its start" + (f" to the end of {sx['end']}" if sx["end"] else ""))
    if method == "GET" and op == "state":
        until = time.time() if is_live else min(float(q.get("until") or end), end)
        acts = BOOK.actions(book)
        st = broker.compute(acts, pr, until, root)
        out = {"feed": account, "root": root, "live": is_live, "session": replay, **st,
               "actions": [a for a in acts if a["t"] <= until]}                  # every move, for the trade's trace
        if replay:
            realized, trades = session_totals(replay, root, book)
            out["session_realized_usd"] = round(realized + st["realized_usd"], 2)
            out["session_trades"] = sorted(trades + st["trades"], key=lambda x: x["t_in"])
            if replay.startswith("s"):
                sx = SESSIONS.get(replay)
                if sx:
                    out["session_name"], out["session_balance"] = sx["name"], sx["balance"]
        return out
    if method != "POST":
        raise KeyError("not found")
    if op == "reset":
        BOOK.reset(book)
        return {"feed": account, "root": root, "live": is_live, "session": replay, **broker.compute([], pr, time.time() if is_live else end, root), "reset": True}
    t = time.time() if is_live else float(body.get("t"))
    if not is_live and not start - 3600 <= t <= end:
        raise ValueError("t: the replay's time on that day")
    price = lambda k: None if body.get(k) in (None, "") else round(float(body[k]) / tick) * tick
    if op == "order":
        side, kind, qty = int(body.get("side", 0)), str(body.get("type", "")), round(float(body.get("qty", 0)), 1)
        if side not in (1, -1) or kind not in broker.TYPES or not 0.1 <= qty <= 100:
            raise ValueError("side 1 or -1, type market / limit / stop, qty 0.1 to 100 (tenths: a tenth of an ES is one MES)")
        if qty == int(qty):
            qty = int(qty)
        if kind != "market" and price("price") is None:
            raise ValueError(f"a {kind} order needs a price")
        act = {"op": "order", "t": t, "id": broker.new_id(), "side": side, "type": kind, "qty": qty, "price": price("price")}
        for k in ("sl", "tp"):
            if price(k) is not None:
                act[k] = price(k)
    elif op == "cancel":
        act = {"op": "cancel", "t": t, "id": str(body.get("id"))}
    elif op == "modify":
        if price("price") is None and "sl" not in body and "tp" not in body:
            raise ValueError("modify needs a price, sl or tp")
        act = {"op": "modify", "t": t, "id": str(body.get("id")), "price": price("price")}
        for k in ("sl", "tp"):
            if k in body:
                act[k] = price(k)
    elif op == "bracket":
        act = {"op": "bracket", "t": t, **{k: price(k) for k in ("sl", "tp") if k in body}}
    elif op in ("flatten", "cancel_all"):
        act = {"op": op, "t": t}
    else:
        raise KeyError("not found")
    dropped = BOOK.add(book, act)
    st = broker.compute(BOOK.actions(book), pr, t, root)
    return {"feed": account, "root": root, "live": is_live, "session": replay, **st, "dropped": dropped}


# ---------------------------------------------------------------- settings, inventory, checks
def config_state():
    raw, eff = settings.load(), settings.resolve()
    defaults = settings.resolve({k: v for k, v in raw.items() if k == "DATA_ROOT"})
    fields = [{"key": key, "group": g, "label": lab, "kind": kind, "restart": restart, "help": help_, "set": raw.get(key, ""),
               "effective": eff.get(key, ""), "default": defaults.get(key, ""),
               "exists": os.path.isdir(eff.get(key, "")) if kind == "path" and eff.get(key) else None}
              for key, (g, lab, kind, restart, help_) in settings.FIELDS.items()]
    return {"config_file": settings.CONFIG_FILE, "first_start": not os.path.exists(settings.CONFIG_FILE), "fields": fields}


def _missing(days):
    if len(days) < 2:
        return []
    have, out = set(days), []
    d, last = date.fromisoformat(days[0]), date.fromisoformat(days[-1])
    while d <= last:
        if d.isoformat() not in have and d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def inventory():
    a = STATE["archive"]
    rows = []
    for root in a.roots():
        days = a.days(root)
        if not days:
            continue
        sd, td = a.second_dir(root), a.tick_dir(root)
        secs = {f[:10] for f in os.listdir(sd) if f.endswith("_1s.csv")} if os.path.isdir(sd) else set()
        ticks = {f[:10] for f in os.listdir(td) if f.endswith("_ticks.csv")} if os.path.isdir(td) else set()
        a.day(root, days[-1])
        sp = specs.spec(root)
        rows.append({"name": root, "days": len(days), "first": days[0], "last": days[-1], "missing": _missing(days),
                     "with_seconds": sum(d in secs for d in days), "with_ticks": sum(d in ticks for d in days),
                     "tick": sp[0], "pv": sp[1], "spec": "Tabelle" if root in specs.SPECS else "aus den Daten"})
    size = 0
    for dp, _, fs in os.walk(a.base):
        size += sum(os.path.getsize(os.path.join(dp, f)) for f in fs)
    return {"path": a.base, "exists": os.path.isdir(a.base), "size": size, "rows": rows}


def save_screenshot(body):
    name = str(body.get("name") or "")
    if not re.fullmatch(r"[A-Za-z0-9._\-]{1,120}", name) or not name.endswith(".png"):
        raise ValueError("name: letters, digits, . _ - and ending in .png")
    data = str(body.get("png") or "")
    raw = base64.b64decode(data.split(",", 1)[-1] if data.startswith("data:") else data, validate=True)
    if not raw.startswith(b"\x89PNG"):
        raise ValueError("png: not a PNG picture")
    folder = STATE["eff"]["SCREENSHOT_DIR"]
    os.makedirs(folder, exist_ok=True)
    path, n = os.path.join(folder, name), 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{name[:-4]}-{n}.png"); n += 1
    with open(path, "wb") as f:
        f.write(raw)
    return {"path": path, "bytes": len(raw)}


# ---------------------------------------------------------------- the http handler
class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype, code=200):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError):
            pass

    def _json(self, obj, code=200):
        self._send(json.dumps(obj).encode(), "application/json", code)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def log_message(self, *a):
        pass

    def _query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    # ---- POST
    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/ingest":
            n = int(self.headers.get("Content-Length", 0))
            try:
                msg = json.loads(self.rfile.read(n))
            except ValueError as ex:
                return self._send(f"bad json: {ex}".encode(), "text/plain", 400)
            code, text = FEEDS.ingest(msg)
            return self._send(text.encode(), "text/plain", code)
        if route.startswith("/api/"):
            return self.api("POST", route)
        return self._send(b"not found", "text/plain", 404)

    # ---- GET
    def do_GET(self):
        try:
            self._get()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            raise
        except Exception as ex:                                 # never a closed connection without an answer
            import traceback
            traceback.print_exc()
            self._json({"error": f"{type(ex).__name__}: {ex}"}, 500)

    def _get(self):
        route = urlparse(self.path).path
        try:
            if route == "/health":
                return self._send(b"ok", "text/plain")
            if route == "/feeds":
                return self._json(FEEDS.rows())
            if route.startswith("/tl/"):
                return self.timeline(route)
            if route.startswith("/api/"):
                return self.api("GET", route)
            if route in ("/", "/index.html"):
                if not os.path.exists(settings.CONFIG_FILE):
                    self.send_response(302); self.send_header("Location", "/config.html"); self.send_header("Content-Length", "0"); self.end_headers()
                    return
                return self.static("index.html")
            return self.static(route.lstrip("/"))
        except ValueError as ex:
            return self._json({"error": str(ex)}, 400)

    def timeline(self, route):
        q = self._query()
        inst = q.get("inst", "")
        if not inst.isalnum():
            raise ValueError("inst: a symbol like ES")
        num = lambda k, d=None: float(q[k]) if q.get(k) not in (None, "") else d
        tf, t0, t1, until = num("tf", 1), num("from", 0), num("to", 4e9), num("until")
        if abs(tf - round(tf)) < 1e-9 and 1 <= tf <= 1440:
            tf = int(round(tf))
        elif abs(tf * 60 - round(tf * 60)) < 1e-6 and int(round(tf * 60)) in (5, 15, 30):
            tf = int(round(tf * 60)) / 60                      # seconds: 5, 15 or 30
        else:
            raise ValueError("tf: 1 to 1440 minutes, or 5, 15, 30 seconds as 1/12, 1/4, 1/2")
        if route == "/tl/sessions":
            days = tl().sessions(inst)
            if days:
                STATE["archive"].day(inst, days[-1])                                 # learns an unknown symbol's tick
            sp = specs.spec(inst)
            a = STATE["archive"]
            secs = set(os.listdir(a.second_dir(inst))) if os.path.isdir(a.second_dir(inst)) else set()
            tks = set(os.listdir(a.tick_dir(inst))) if os.path.isdir(a.tick_dir(inst)) else set()
            return self._json({"inst": inst, "instruments": tl().roots(), "tick": sp[0], "pv": sp[1], "name": sp[2], "specs": specs.known(),
                               "sessions": [{"date": d, "start": session.bounds(d)[0], "end": session.bounds(d)[1],
                                             "seconds": f"{d}_1s.csv" in secs, "ticks": f"{d}_ticks.csv" in tks} for d in days]})
        if route == "/tl/bars":
            return self._json({"inst": inst, "tf": tf, "until": until, "bars": tl().bars(inst, tf, t0, t1, until)})
        if route == "/tl/levels":
            return self._json({"inst": inst, "tf": tf, "until": until, "levels": {str(k): v for k, v in tl().levels(inst, tf, t0, t1, until).items()}})
        if route == "/tl/profile":
            return self._json({"inst": inst, "from": t0, "to": t1, "until": until, **tl().profile(inst, t0, t1, until)})
        if route == "/tl/amt":
            row, naked = int(q.get("row", 4)), int(q.get("naked", 0))
            if not (1 <= row <= 400) or not (0 <= naked <= 60):
                raise ValueError("row: 1..400 ticks, naked: 0..60 sessions")
            eth = q.get("eth", "0") in ("1", "true")
            return self._json({"inst": inst, "from": t0, "to": t1, "until": until, "row": row, **prof.window(tl(), inst, t0, t1, until, row, eth, naked)})
        return self._send(b"not found", "text/plain", 404)

    # ---- /api: the token
    def api(self, method, route):
        port = self.server.server_address[1]
        if not host_ok(self.headers.get("Host", ""), port):
            return self._json({"error": "wrong host"}, 403)
        body = {}
        if method == "POST":
            origin = self.headers.get("Origin")
            if origin is not None and not (origin.startswith("http://") and host_ok(origin[len("http://"):], port)):
                return self._json({"error": "foreign origin"}, 403)
            if not secrets.compare_digest(self.headers.get("X-Replay-Token", ""), TOKEN):
                return self._json({"error": "token missing or wrong - reload the page"}, 403)
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n > (40_000_000 if route == "/api/screenshot" else 1_000_000):
                return self._json({"error": "too large"}, 413)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._json({"error": "bad json"}, 400)
            if not isinstance(body, dict):
                return self._json({"error": "expected an object"}, 400)
        q = self._query()
        if method == "GET" and route == "/api/clock/stream":
            return clock.stream(self)
        try:
            if route == "/api/clock":
                return self._json(clock.snapshot() if method == "GET" else clock.change(body))
            if method == "POST" and route == "/api/cross":                       # one window's cursor for the others
                return self._json(clock.cross(body))
            if route.startswith("/api/broker/"):
                return self._json(broker_call(method, route[len("/api/broker/"):], body, q))
            if method == "POST" and route == "/api/screenshot":
                return self._json(save_screenshot(body))
            if route == "/api/config":
                if method == "POST":
                    changes = body.get("settings") or {}
                    if not isinstance(changes, dict):
                        raise ValueError("settings must be an object")
                    restart = settings.save({k: ("" if v is None else str(v)) for k, v in changes.items()})
                    apply_settings()
                    return self._json({**config_state(), "restart": restart})
                return self._json(config_state())
            if method == "POST" and route == "/api/folders/create":
                made = []
                for key in ("DATA_ROOT", "SCREENSHOT_DIR", "DATA_DIR"):
                    p = STATE["eff"].get(key)
                    if p and not os.path.isdir(p):
                        os.makedirs(p, exist_ok=True); made.append(p)
                apply_settings()
                return self._json({"created": made})
            if route == "/api/workspaces":
                if method == "GET":
                    wid, inst = q.get("id"), q.get("inst")
                    if wid and inst:
                        return self._json(WORKSPACES.drawings(wid, inst))
                    if wid:
                        return self._json(WORKSPACES.get(wid))
                    return self._json({"workspaces": WORKSPACES.list()})
                op = str(body.get("op") or "")
                wid = str(body.get("id") or "")
                if op == "create":
                    return self._json(WORKSPACES.create(body.get("name"), body.get("layout"), body.get("drawings")))
                if op == "rename":
                    return self._json(WORKSPACES.rename(wid, body.get("name")))
                if op == "duplicate":
                    return self._json(WORKSPACES.duplicate(wid, body.get("name")))
                if op == "delete":
                    return self._json(WORKSPACES.delete(wid))
                if op == "layout":
                    return self._json(WORKSPACES.set_layout(wid, body.get("layout")))
                if op == "drawings":
                    out = WORKSPACES.merge(wid, str(body.get("inst") or ""), body.get("list"), body.get("deleted") or {})
                    clock.notify({"ws": {"id": wid, "inst": out["inst"], "origin": str(body.get("origin") or "")[:16]}})
                    return self._json(out)
                raise ValueError("op: create, rename, duplicate, delete, layout or drawings")
            if route == "/api/sessions":
                if method == "GET":
                    sid = q.get("id")
                    return self._json(SESSIONS.stats(sid) if sid else {"sessions": SESSIONS.list()})
                op = str(body.get("op") or "")
                if op == "create":
                    return self._json(SESSIONS.create(body))
                if op == "update":
                    return self._json(SESSIONS.update(str(body.get("id") or ""), body))
                if op == "delete":
                    return self._json(SESSIONS.delete(str(body.get("id") or "")))
                if op == "trade":
                    return self._json(SESSIONS.journal_trade(str(body.get("id") or ""), str(body.get("trade") or ""), body))
                if op == "day":
                    return self._json(SESSIONS.journal_day(str(body.get("id") or ""), str(body.get("day") or ""), body))
                raise ValueError("op: create, update, delete, trade or day")
            if method == "GET" and route == "/api/inventory":
                return self._json(inventory())
            if method == "GET" and route == "/api/check":
                root, td = q.get("inst", ""), q.get("date", "")
                if not root.isalnum() or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", td):
                    raise ValueError("inst and date")
                return self._json({"inst": root, "date": td, "findings": STATE["archive"].check(root, td)})
            if method == "GET" and route == "/api/status":
                missing = [k for k in settings.FOLDERS if not os.path.isdir(STATE["eff"][k])]
                return self._json({"setup": {"first_start": not os.path.exists(settings.CONFIG_FILE), "missing_folders": missing},
                                   "receiver": f"http://127.0.0.1:{port}/ingest", "feeds": FEEDS.rows()})
            return self._json({"error": "not found"}, 404)
        except (KeyError, ValueError) as ex:
            return self._json({"error": str(ex).strip("'")}, 400)

    # ---- static files
    def static(self, rel):
        path = os.path.realpath(os.path.join(WEB, rel))
        if ".." in rel or not path.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(path):
            return self._send(b"not found", "text/plain", 404)
        ctype = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml"}.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as fh:
            body = fh.read()
        if rel in TOKEN_PAGES:
            body = body.replace(b"__REPLAY_TOKEN__", TOKEN.encode())
        return self._send(body, ctype)


def host_ok(host, port):
    """the Host a request names must be this server: 127.0.0.1 / localhost, or in LAN mode an IP address or this
    machine's name on our port - a DNS name of someone else's never (no DNS rebinding)"""
    name, _, p = host.partition(":")
    if p != str(port):
        return False
    if name in ("127.0.0.1", "localhost", "[::1]"):
        return True
    if not (STATE["eff"] or {}).get("LAN"):
        return False
    return bool(re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", name)) or name.lower() == socket.gethostname().lower()


def lan_addresses():
    """the IPv4 addresses of this machine (for the start message)"""
    out = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            out.add(info[4][0])
    except OSError:
        pass
    try:                                                        # the address the default route uses
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("10.255.255.255", 1)); out.add(s.getsockname()[0]); s.close()
    except OSError:
        pass
    return sorted(a for a in out if not a.startswith("127."))


SESSIONS = sess.Sessions(os.path.join(LOGS, "sessions"), BOOK, prints_of)


def make_server(port):
    apply_settings()
    return ThreadingHTTPServer(("0.0.0.0" if STATE["eff"].get("LAN") else "127.0.0.1", port), H)


def main():
    first = not os.path.exists(settings.CONFIG_FILE)
    eff = apply_settings()
    port = eff["PORT"]
    print(f"replay:          http://127.0.0.1:{port}/")
    print(f"settings:        http://127.0.0.1:{port}/config.html")
    print(f"live from the Rithmic Bridge: http://127.0.0.1:{port}/ingest   (its \"Viewer\" URL)")
    print(f"archive:         {eff['DATA_DIR']}" + ("" if os.path.isdir(eff["DATA_DIR"]) else "   (not there - set it on the settings page)"))
    if first:
        print("first start: no replay.cfg yet - the page opens the settings first")
    if eff.get("LAN"):
        for a in lan_addresses():
            print(f"in the home network:  http://{a}:{port}/   (iPad, phone, another PC)")
    try:
        srv = ThreadingHTTPServer(("0.0.0.0" if eff.get("LAN") else "127.0.0.1", port), H)
    except OSError as ex:
        print(f"\nport {port} is taken ({ex}): an older version still running? Close it, or set another PORT on the settings page.")
        sys.exit(1)
    print("this window is the server: leave it open while you work, closing it ends the replay")
    srv.serve_forever()


if __name__ == "__main__":
    main()
