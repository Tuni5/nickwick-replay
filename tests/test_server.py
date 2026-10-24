"""main.py: the routes on the real day, the token, live ingest, the broker's accounts, settings"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import pytest

import main as M
import session
import settings
from conftest import DATA, DAY

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work")
os.environ.setdefault("REPLAY_CFG", os.path.join(WORK, "replay.cfg"))


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CONFIG_FILE", str(tmp_path / "replay.cfg"))
    monkeypatch.setattr(M, "LOGS", str(tmp_path / "logs"))
    monkeypatch.setattr(M, "BOOK", M.broker.Book(str(tmp_path / "logs" / "broker")))
    monkeypatch.setattr(M.FEEDS, "prints_dir", str(tmp_path / "logs" / "prints"))
    monkeypatch.setattr(M.FEEDS, "live_dir", str(tmp_path / "logs" / "live"))
    settings.write_kv(settings.CONFIG_FILE, {"DATA_DIR": DATA, "SCREENSHOT_DIR": str(tmp_path / "shots")})
    M.STATE["eff"] = None
    srv = M.make_server(0)
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    yield Client(srv.server_address[1])
    srv.shutdown(); srv.server_close()
    M.FEEDS.clear()
    M.FEEDS.live_dir = None


class Client:
    def __init__(self, port):
        self.port, self.base = port, f"http://127.0.0.1:{port}"

    def call(self, method, path, body=None, token=True, headers=None, raw=False):
        h = {"Content-Type": "application/json"}
        if token and method == "POST":
            h["X-Replay-Token"] = M.TOKEN
        h.update(headers or {})
        data = None if body is None else json.dumps(body).encode()
        if method == "POST" and data is None:
            data = b"{}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                payload, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            payload, code = e.read(), e.code
        return code, (payload if raw else (json.loads(payload) if payload else None))

    def get(self, path, **kw):
        return self.call("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.call("POST", path, body, **kw)


START, END = session.bounds(DAY)


def test_timeline_routes_on_the_real_day(server):
    code, j = server.get("/tl/sessions?inst=ES")
    assert code == 200 and [s["date"] for s in j["sessions"]] == [DAY] and j["instruments"] == ["ES"]
    code, j = server.get(f"/tl/bars?inst=ES&tf=30&from=0&to=4e9&until={START + 3600 + 30}")
    assert code == 200 and len(j["bars"]) == 3 and j["bars"][-1]["forming"]
    code, j = server.get(f"/tl/levels?inst=ES&tf=5&from={START}&to={START + 300}")
    assert code == 200 and list(j["levels"]) == [str(START)] and sum(v for _, v, _, _ in j["levels"][str(START)]) == sum(b["v"] for b in server.get(f"/tl/bars?inst=ES&tf=1&from={START}&to={START + 300}")[1]["bars"])
    code, j = server.get(f"/tl/profile?inst=ES&from={START}&to={END}&until={START + 7200}")
    assert code == 200 and j["poc"] is not None and j["total"] > 0
    code, j = server.get(f"/tl/amt?inst=ES&from={START}&to={END}&naked=3")
    assert code == 200 and j["sessions"][0]["rth"]["vp"]["total"] == 663218 and j["naked"] == []
    assert server.get("/tl/bars?inst=E%20S")[0] == 400 and server.get("/tl/bars?inst=ES&tf=0")[0] == 400
    assert server.get("/nothing", raw=True)[0] == 404 and server.get("/../server/main.py", raw=True)[0] == 404


def test_pages_and_the_token(server):
    code, page = server.get("/", raw=True)
    assert code == 200 and M.TOKEN.encode() in page and b"__REPLAY_TOKEN__" not in page and b'/tv/app.js' in page
    page = server.get("/config.html", raw=True)[1]
    assert M.TOKEN.encode() in page
    assert M.TOKEN.encode() not in server.get("/tv/app.js", raw=True)[1]
    assert server.post("/api/clock", {"action": "pause"}, token=False)[0] == 403
    assert server.get("/api/config", headers={"Host": "evil.example:1"})[0] == 403
    assert server.post("/api/folders/create", headers={"Origin": "https://evil.example"})[0] == 403
    assert server.post("/api/clock", {"action": "pause"})[0] == 200
    assert server.get("/api/status")[1]["receiver"].endswith("/ingest")
    for path in ("/heatmap.html", "/trainer.html", "/live.html", "/app/r-clock.js", "/state", "/depth", "/api/jobs", "/api/sessions"):
        assert server.get(path, raw=True)[0] == 404, path


def test_first_start_and_settings(server, tmp_path):
    os.remove(settings.CONFIG_FILE)
    code, page = server.get("/", raw=True)
    assert code == 200 and "Erster Start" in page.decode()                    # followed the redirect to the settings
    code, j = server.post("/api/config", {"settings": {"DATA_DIR": DATA, "PORT": "8030"}})
    assert code == 200 and j["restart"] == ["PORT"] and not j["first_start"]
    assert server.post("/api/config", {"settings": {"DEPTH_HISTORY_DIR": "x"}})[0] == 400
    inv = server.get("/api/inventory")[1]
    assert inv["rows"][0] == {"name": "ES", "days": 1, "first": DAY, "last": DAY, "missing": [], "with_seconds": 1, "with_ticks": 0}
    ck = server.get(f"/api/check?inst=ES&date={DAY}")[1]["findings"]
    assert any("20:59" in f["text"] for f in ck) and any("109" in f["text"] for f in ck)


def test_broker_on_the_real_day(server):
    feed, r0 = f"ES.1m@{DAY}", session.rth(DAY)[0]
    assert server.post("/api/broker/order", {"feed": feed, "t": r0, "side": 1, "type": "market", "qty": 1}, token=False)[0] == 403
    code, st = server.post("/api/broker/order", {"feed": feed, "t": r0 + 0.5, "side": 1, "type": "market", "qty": 2})
    assert code == 200 and st["pos"] == 0 and len(st["orders"]) == 1 and "1-second" in st["prints_from"]
    code, st = server.get(f"/api/broker/state?feed={feed}&until={r0 + 5}")
    assert st["pos"] == 2 and r0 + 0.5 < st["fills"][0]["t"] < r0 + 5
    code, st = server.post("/api/broker/bracket", {"feed": feed, "t": r0 + 60, "sl": st["avg"] - 2.13, "tp": st["avg"] + 3})
    assert code == 200 and st["bracket"]["sl"] % 0.25 == 0 and {o["id"] for o in st["orders"]} == {"sl", "tp"}
    assert server.get(f"/api/broker/state?feed={feed}&until={END + 99999}")[1]["until"] <= END
    assert server.post("/api/broker/order", {"feed": "ES.1m@2020-01-01", "t": r0, "side": 1, "type": "market", "qty": 1})[0] == 400
    assert server.post("/api/broker/order", {"feed": feed, "t": START - 9000, "side": 1, "type": "market", "qty": 1})[0] == 400
    code, st = server.post("/api/broker/reset", {"feed": feed})
    assert code == 200 and st["pos"] == 0 and st["trades"] == []


def msg(**kw):
    s, _ = session.bounds(session.trade_date(time.time()))
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    m = {"source": "s1", "instrument": "ESZ6", "exchange": "CME", "tick": 0.25, "timeframe": "M1", "full": True,
         "candles": [{"time": iso(s + 60 * i), "o": 7000, "h": 7001, "l": 6999, "c": 7000.5, "v": 10, "bid": 4, "ask": 6,
                      "lv": [[7000.0, 6, 2, 4], [7000.25, 4, 2, 2]]} for i in range(3)]}
    m.update(kw)
    return m


def test_live_feed_in_the_timeline_and_paper_trading(server):
    assert server.post("/ingest", raw=True, body=msg(instrument="?"), token=False)[0] == 425
    assert server.post("/ingest", raw=True, body=msg(full=False, source="new"), token=False)[0] == 409
    assert server.post("/ingest", raw=True, body=msg(), token=False)[0] == 200
    assert server.post("/ingest", raw=True, body=msg(full=False, heartbeat=True), token=False)[0] == 200
    assert server.post("/ingest", raw=True, body=msg(full=False, depth=[{"bid": [1]}], profile={}), token=False)[0] == 200   # older bridges' extras: ignored
    feeds = server.get("/feeds")[1]
    assert [f["src"] for f in feeds] == ["s1"] and feeds[0]["root"] == "ES" and feeds[0]["candle_seconds"] == 60 and not feeds[0]["ticks"]
    td = session.trade_date(time.time()); s, _ = session.bounds(td)
    assert td in [x["date"] for x in server.get("/tl/sessions?inst=ES")[1]["sessions"]]
    bars = server.get(f"/tl/bars?inst=ES&tf=1&from={s}&to={s + 600}")[1]["bars"]
    assert [b["v"] for b in bars] == [10, 10, 10] and (bars[0]["buy"], bars[0]["sell"]) == (6, 4)
    lv = server.get(f"/tl/levels?inst=ES&tf=5&from={s}&to={s + 600}")[1]["levels"]
    assert lv[str(s)] == [[7000.0, 18, 12, 6], [7000.25, 12, 6, 6]]                 # buy = ask, sell = bid
    now = time.time()
    early = [[int((now - 5 + i) * 1e6), 7000.0 + 0.25 * i, 1, 1 if i % 2 else -1] for i in range(4)]
    assert server.post("/ingest", raw=True, body=msg(full=False, ticks=early), token=False)[0] == 200
    code, st = server.post("/api/broker/order", {"feed": "s1", "t": 0, "side": 1, "type": "market", "qty": 1})
    assert code == 200 and st["live"] and st["pos"] == 0
    time.sleep(0.05)
    later = [[int((time.time() + 0.01) * 1e6), 7001.0, 1, -1], [int((time.time() + 0.02) * 1e6), 7001.25, 2, 1]]
    server.post("/ingest", raw=True, body=msg(full=False, ticks=later), token=False)
    time.sleep(0.1)
    st = server.get("/api/broker/state?feed=s1")[1]
    assert st["pos"] == 1 and st["avg"] == 7001.25 and "live" in st["prints_from"]
    M.FEEDS._feeds["s1"]["at"] = 0                                               # the bridge fell silent: the day stays
    assert td in [x["date"] for x in server.get("/tl/sessions?inst=ES")[1]["sessions"]]
    assert server.get("/feeds")[1][0]["stale"] and server.get("/api/broker/state?feed=s1")[0] == 200
    bars = server.get(f"/tl/bars?inst=ES&tf=1&from={s}&to={s + 600}")[1]["bars"]
    assert [b["v"] for b in bars] == [10, 10, 10]
    # a restarted server reads the day back from disk
    monkeypatch_dir = M.FEEDS.live_dir
    M.FEEDS._feeds.clear()
    M.FEEDS._load_days()
    assert td in [x["date"] for x in server.get("/tl/sessions?inst=ES")[1]["sessions"]]


def test_todays_forming_minute_comes_from_the_bridges_prints(server):
    """today has no 1-second file yet: replaying an earlier minute of today builds it from the prints the bridge sent"""
    td = session.trade_date(time.time()); s, _ = session.bounds(td)
    m = msg()                                                   # three whole minutes from the session start
    m0 = s + 600                                                # a minute later on, no candle for it in the feed
    ticks = [[int((m0 + 5 + i) * 1e6), 7010.0 + 0.25 * (i % 3), 2, 1 if i % 2 else -1] for i in range(20)]
    assert server.post("/ingest", raw=True, body=dict(m, ticks=ticks), token=False)[0] == 200
    until = m0 + 14.5                                           # the prints at +5 .. +14 lie before the clock: ten of them
    bars = server.get(f"/tl/bars?inst=ES&tf=1&from={s}&to={s + 3600}&until={until}")[1]["bars"]
    last = bars[-1]
    assert last["t"] == m0 and last["forming"] and last["v"] == 20 and last["buy"] == 10 and last["sell"] == 10
    assert last["o"] == 7010.0 and last["c"] == 7010.0 and last["h"] == 7010.5
    lv = server.get(f"/tl/levels?inst=ES&tf=1&from={m0}&to={m0 + 60}&until={until}")[1]["levels"][str(m0)]
    assert lv == [[7010.0, 8, 4, 4], [7010.25, 6, 4, 2], [7010.5, 6, 2, 4]]           # by hand from the prints
    none = server.get(f"/tl/bars?inst=ES&tf=1&from={s}&to={s + 3600}&until={m0 + 2}")[1]["bars"]
    assert none[-1]["t"] < m0                                   # before the first print of the minute: nothing of it yet


def test_todays_prints_survive_a_restart(server):
    """the bridge's full snapshot carries only the prints since it started: the server keeps every print it got on
    disk and reads them back when the feed comes again - nothing twice, nothing lost"""
    m = msg()
    t0 = time.time() - 60
    first = [[int((t0 + i) * 1e6), 7000.0, 1, 1] for i in range(5)]
    assert server.post("/ingest", raw=True, body=dict(m, ticks=first), token=False)[0] == 200
    assert len(M.FEEDS.prints_of("ES")[0]) == 5
    M.FEEDS.clear()                                                       # the server restarted
    again = [first[-1], [int((t0 + 9) * 1e6), 7000.25, 2, -1]]            # the snapshot repeats the last one, adds one
    assert server.post("/ingest", raw=True, body=dict(m, ticks=again), token=False)[0] == 200
    t, px, sz, side = M.FEEDS.prints_of("ES")
    assert len(t) == 6 and list(px[-2:]) == [7000.0, 7000.25] and side[-1] == -1
    path = os.path.join(M.FEEDS.prints_dir, f"ES_{session.trade_date(t0)}.csv")
    assert os.path.exists(path) and len(open(path).read().splitlines()) == 6


def test_lan_mode_accepts_the_machines_addresses_only(server, monkeypatch):
    port = server.port
    assert M.host_ok(f"127.0.0.1:{port}", port) and not M.host_ok(f"192.168.1.20:{port}", port)
    M.STATE["eff"]["LAN"] = True
    assert M.host_ok(f"192.168.1.20:{port}", port) and M.host_ok(f"{__import__('socket').gethostname()}:{port}", port)
    assert not M.host_ok(f"evil.example:{port}", port) and not M.host_ok(f"192.168.1.20:{port + 1}", port)
    assert server.get("/api/status", headers={"Host": f"192.168.1.20:{port}"})[0] == 200
    assert server.post("/api/clock", {"action": "pause"}, headers={"Host": f"192.168.1.20:{port}", "Origin": f"http://192.168.1.20:{port}"})[0] == 200
    assert server.post("/api/clock", {"action": "pause"}, headers={"Host": f"192.168.1.20:{port}", "Origin": "http://evil.example"})[0] == 403
    M.STATE["eff"]["LAN"] = False
    code, j = server.post("/api/config", {"settings": {"LAN": "1"}})
    assert code == 200 and j["restart"] == ["LAN"]
