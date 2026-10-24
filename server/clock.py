"""
clock.py - the replay clock, one for every window and every chart.

The clock is a reference point, not a ticking counter: replay time `t` at server wall time `wall`, a `speed` and
whether it plays. Every window computes the current replay time itself, t + (now - wall) * speed, so playing costs no
traffic; only a change (play, pause, seek, speed, instrument) is sent, to every window at once, over a server-sent
event stream (GET /api/clock/stream). Changes come in through POST /api/clock with this run's token (api.py).

What the clock does not do: it does not know which days exist and does not stop at the end of the data - a window
simply shows what there is up to the clock (nothing after it, the timeline's `until`).
"""
import json
import queue
import threading
import time

LOCK = threading.Lock()
KEEPALIVE_S = 10.0                                # a comment line on the stream this often, so a dead socket shows
SPEEDS = (0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600)

_state = {"inst": "", "t": None, "wall": 0.0, "speed": 10.0, "playing": False, "rev": 0, "origin": "", "live": False, "replay": ""}
# replay: the id of the replay running now. Leaving live (a seek, play, pause) opens one when none is open; "live"
# closes it. The broker's accounts of a replay are named after it (main.py), so "Close Replay" can delete them.
_subs = []                                        # one queue per open stream


def now_t(s=None, wall_now=None):
    """the replay time now"""
    s = s or _state
    if s["t"] is None:
        return None
    if not s["playing"]:
        return s["t"]
    return s["t"] + ((wall_now if wall_now is not None else time.time()) - s["wall"]) * s["speed"]


def snapshot():
    with LOCK:
        s = dict(_state)
    s["server"] = time.time()
    s["now"] = now_t(s, s["server"])
    return s


def _publish(s):
    for q in list(_subs):
        try:
            q.put_nowait(s)
        except queue.Full:
            pass


def change(body):
    """one change: {action: seek|play|pause|toggle|speed|inst|set, t?, speed?, inst?, origin?} -> the new state"""
    act = body.get("action")
    if act not in ("seek", "play", "pause", "toggle", "speed", "inst", "set", "live", "session"):
        raise ValueError("action: seek, play, pause, toggle, speed, inst, set, live or session")
    with LOCK:
        wall = time.time()
        cur = now_t(_state, wall)
        t = body.get("t")
        if t is not None:
            t = float(t)
            if not (0 < t < 4e9):
                raise ValueError("t: epoch seconds")
        sp = body.get("speed")
        if sp is not None:
            sp = float(sp)
            if not (0 < sp <= 3600):
                raise ValueError("speed: 0 < speed <= 3600")
        inst = body.get("inst")
        if inst is not None and (not isinstance(inst, str) or not inst.isalnum() or len(inst) > 12):
            raise ValueError("inst: a symbol like ES")
        s = _state
        s["t"] = t if t is not None else cur
        s["wall"] = wall
        if act == "play":
            s["playing"] = True
        elif act == "pause":
            s["playing"] = False
        elif act == "toggle":
            s["playing"] = not s["playing"]
        if sp is not None:
            s["speed"] = sp
        if inst is not None:
            s["inst"] = inst
        if act == "set" and "playing" in body:
            s["playing"] = bool(body["playing"])
        # live (v1.2): the clock is the wall clock - now, 1x, playing; every other change leaves live
        s["live"] = act == "live" or (act == "inst" and s.get("live", False))
        if act == "session":                                   # a named session takes the clock: its id is the replay's
            sid = str(body.get("session") or "")
            if not sid.startswith("s") or not sid[1:].isalnum():
                raise ValueError("session: the session's id")
            s["replay"] = sid
            s["playing"] = False
        if s["live"]:
            s["t"], s["speed"], s["playing"] = wall, 1.0, True
            s["replay"] = ""
        elif s["t"] is not None and not s.get("replay"):
            s["replay"] = "r" + hex(int(wall * 1000))[2:]
        if s["t"] is None:
            s["playing"] = False
        s["rev"] += 1
        s["origin"] = str(body.get("origin") or "")[:64]
        out = dict(s)
    out["server"] = out["wall"]
    out["now"] = out["t"]
    _publish(out)
    return out


def notify(msg):
    """a message for every open stream (other windows), kept nowhere"""
    with LOCK:
        for q in list(_subs):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


def cross(body):
    """POST /api/cross: one window's cursor for the others - {inst, t, p, origin} or {origin} alone when it left the
    chart; goes to every stream as {"cross": …}, kept nowhere"""
    inst = str(body.get("inst") or "")
    origin = str(body.get("origin") or "")[:16]
    t, p = body.get("t"), body.get("p")
    msg = {"cross": {"inst": inst, "origin": origin, "t": float(t) if t is not None else None, "p": float(p) if p is not None else None}}
    with LOCK:
        for q in list(_subs):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass
    return {"ok": True}


def reset():
    """for the tests"""
    with LOCK:
        _state.update({"inst": "", "t": None, "wall": 0.0, "speed": 10.0, "playing": False, "rev": 0, "origin": "", "live": False, "replay": ""})


def stream(h):
    """GET /api/clock/stream: the state at once, then every change; a comment line every KEEPALIVE_S"""
    q = queue.Queue(maxsize=64)
    _subs.append(q)
    try:
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream")
        h.send_header("Cache-Control", "no-store")
        h.send_header("Connection", "keep-alive")
        h.end_headers()
        h.wfile.write(f"retry: 1000\ndata: {json.dumps(snapshot())}\n\n".encode())
        h.wfile.flush()
        while True:
            try:
                s = q.get(timeout=KEEPALIVE_S)
                h.wfile.write(f"data: {json.dumps(s)}\n\n".encode())
            except queue.Empty:
                h.wfile.write(b": keepalive\n\n")
            h.wfile.flush()
    except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError, OSError):
        pass
    finally:
        if q in _subs:
            _subs.remove(q)
        h.close_connection = True
