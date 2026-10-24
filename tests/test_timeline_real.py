"""timeline.py against the real day, number by number: what the server returns equals what reference.py computes
straight from the files (no code in common)"""
import session
import timeline as T
import reference as R
from conftest import DAY, DATA

START, END = session.bounds(DAY)


def test_the_session_is_what_the_meta_says(arch):
    m = R.meta(DAY)
    assert (START, END) == (R.epoch(m["session_start_utc"]), R.epoch(m["session_end_utc"]))
    assert arch.days("ES") == [DAY] and arch.roots() == ["ES"]
    d = arch.day("ES", DAY)
    assert d.t.size == m["bars"] == 1379 and int(d.v.sum()) == m["volume"]
    assert int(d.lv_v.sum()) == m["volume"]                       # the levels add up to the day


def test_every_bar_of_every_timeframe(tl):
    mins = R.minutes(DAY)
    for tf in (1, 5, 15, 30, 60, 240, 1440):
        want = R.bars(mins, tf, START)
        got = [b for b in tl.bars("ES", tf, 0, 4e9) if not b["approx"]]       # the last minute 20:59 comes from seconds only
        got_by_t = {b["t"]: b for b in got}
        if tf == 1440:
            assert len(got) == 0                                           # the day bar holds 20:59 (approx) - checked below
            continue
        for t, w in want.items():
            if any(x not in got_by_t for x in (t,)):
                assert t >= START + 23 * 3600 - 60 * tf, t                   # only the bucket holding 20:59 may be approx
                continue
            g = got_by_t[t]
            for k in ("o", "h", "l", "c", "v", "buy", "sell"):
                assert g[k] == w[k], (tf, t, k, g[k], w[k])
            assert g["delta"] == w["buy"] - w["sell"] and not g["forming"]


def test_the_minute_only_the_seconds_have(tl, arch):
    """2026-10-12 20:59 is in the 1-second file (327 contracts) but not in the minute file: shown, marked approx"""
    mins = R.minutes(DAY)
    assert START + 23 * 3600 - 60 not in mins
    last = tl.bars("ES", 1, 0, 4e9)[-1]
    assert last["t"] == START + 23 * 3600 - 60 and last["approx"] and last["v"] == 327
    secs = R.forming(R.seconds(DAY), last["t"], last["t"] + 60)
    assert (last["o"], last["h"], last["l"], last["c"], last["buy"], last["sell"]) == (secs["o"], secs["h"], secs["l"], secs["c"], secs["buy"], secs["sell"])
    day = tl.bars("ES", 1440, 0, 4e9)
    assert len(day) == 1 and day[0]["approx"] and day[0]["v"] == R.meta(DAY)["volume"] + 327
    found = arch.check("ES", DAY)
    assert any(f["kind"] == "seconds" and "20:59" in f["text"] for f in found)
    assert any(f["kind"] == "seconds" and "109 without an aggressor" in f["text"] for f in found)   # the opening second


def test_levels_per_bar_are_the_minutes_levels_summed(tl):
    mins = R.minutes(DAY)
    for tf in (5, 30, 240):
        want = R.bars(mins, tf, START)
        got = tl.levels("ES", tf, 0, 4e9)
        for t, w in want.items():
            if t >= START + 23 * 3600 - 60 * tf:
                continue
            g = {p: [v, b, s] for p, v, b, s in got[t]}
            assert g == w["levels"], (tf, t)
            assert sum(v for v, _, _ in g.values()) == w["v"]


def test_profiles_and_the_value_area(tl):
    mins = R.minutes(DAY)
    r0, r1 = session.rth(DAY)
    rows = R.levels_of(mins, r0, r1)
    got = tl.profile("ES", r0, r1)
    assert {p: v for p, v, _, _ in got["levels"]} == rows
    want = R.profile(rows)
    assert (got["poc"], got["vah"], got["val"], got["total"]) == (want["poc"], want["vah"], want["val"], want["total"])
    assert got["total"] == 663218                                      # the RTH volume of the day, by hand


def test_nothing_after_the_clock_and_the_forming_minute(tl):
    mins, secs = R.minutes(DAY), R.seconds(DAY)
    for until in (START + 100 * 60 + 30, session.rth(DAY)[0] + 17 * 60 + 5, END - 120 + 1):
        bars = tl.bars("ES", 5, 0, 4e9, until)
        assert all(b["t"] < until for b in bars)
        want = R.bars(mins, 5, START, until)
        m0 = (until // 60) * 60
        f = R.forming(secs, m0, until)
        last = bars[-1]
        assert last["forming"]
        bucket = START + ((m0 - START) // 300) * 300
        whole = want.get(bucket)
        v = (whole["v"] if whole else 0) + (f["v"] if f else 0)
        assert last["t"] == bucket and last["v"] == v, (until, last["v"], v)
        if f:
            assert last["c"] == f["c"] and last["h"] >= f["h"] and last["l"] <= f["l"]
        whole_bars = [b for b in bars if not b["forming"] and not b["approx"]]
        for b in whole_bars:
            w = want[b["t"]]
            assert (b["o"], b["c"], b["v"]) == (w["o"], w["c"], w["v"])
        prof = tl.profile("ES", START, END, until)
        rows = R.levels_of(mins, START, END, until)
        assert prof["total"] == sum(rows.values()) + (f["v"] if f else 0)


def test_the_opening_minute_from_seconds_differs_from_the_minute_file(tl):
    """the user's data: the first second carries 109 contracts without an aggressor that the minute file lacks -
    while the clock is inside the first minute the tool shows the seconds' figure, at 22:01 the minute file's"""
    until = START + 30
    b = tl.bars("ES", 1, 0, 4e9, until)[-1]
    f = R.forming(R.seconds(DAY), START, until)
    assert b["forming"] and b["v"] == f["v"] and b["buy"] + b["sell"] < b["v"]
    whole = tl.bars("ES", 1, 0, 4e9, START + 60)[-1]
    assert not whole["forming"] and whole["v"] == 822 and whole["buy"] + whole["sell"] == 822


def test_bars_of_seconds_from_the_real_seconds(tl):
    """5-second bars of the real day: whole seconds summed per bucket from the 1-second file (levels spread: approx)"""
    secs = R.seconds(DAY)
    r0 = session.rth(DAY)[0]
    for tfs in (5, 15, 30):
        bars = tl.bars("ES", tfs / 60, r0, r0 + 600)
        want = {}
        for s in secs:
            if r0 <= s[0] < r0 + 600:
                k = r0 + ((s[0] - r0) // tfs) * tfs
                b = want.get(k)
                if b is None:
                    want[k] = {"o": s[1], "h": s[2], "l": s[3], "c": s[4], "v": s[5], "buy": s[6], "sell": s[7]}
                else:
                    b["h"] = max(b["h"], s[2]); b["l"] = min(b["l"], s[3]); b["c"] = s[4]; b["v"] += s[5]; b["buy"] += s[6]; b["sell"] += s[7]
        assert [b["t"] for b in bars] == sorted(want)
        for b in bars:
            w = want[b["t"]]
            assert (b["o"], b["h"], b["l"], b["c"], b["v"], b["buy"], b["sell"]) == (w["o"], w["h"], w["l"], w["c"], w["v"], w["buy"], w["sell"])
            assert b["approx"] and not b["forming"]
    cut = tl.bars("ES", 5 / 60, r0, r0 + 600, r0 + 12.5)
    assert cut[-1]["t"] == r0 + 10 and cut[-1]["forming"] and all(b["t"] + 5 <= r0 + 15 for b in cut)
    lv = tl.levels("ES", 5 / 60, r0, r0 + 10)
    for t, rows in lv.items():
        assert sum(v for _, v, _, _ in rows) == sum(s[5] for s in secs if t <= s[0] < t + 5)


def test_a_missing_weekday_comes_as_empty_slots(tmp_path):
    """an archive with Monday and Wednesday: Tuesday arrives as gap slots between them, one per bucket, flagged"""
    import shutil, os
    import archive as A, timeline as T
    for d, src in (("2026-10-12", "2026-10-12"), ("2026-10-14", "2026-10-12")):
        dst = tmp_path / "1m-bars" / "ES"; dst.mkdir(parents=True, exist_ok=True)
        for suf in ("_bars.csv", "_levels.csv", ".meta.json"):
            p = os.path.join(DATA, "1m-bars", "ES", src + suf)
            txt = open(p).read().replace("2026-10-11T", "2026-10-13T").replace("2026-10-12", "2026-10-14") if d == "2026-10-14" else open(p).read()
            (dst / (d + suf)).write_text(txt)
    tl = T.Timeline(A.Archive(str(tmp_path)))
    assert tl.sessions("ES") == ["2026-10-12", "2026-10-14"]
    bars = tl.bars("ES", 30, 0, 4e9)
    gaps = [b for b in bars if b.get("gap")]
    s0, s1 = session.bounds("2026-10-13")
    assert len(gaps) == 46 and gaps[0]["t"] == s0 and gaps[-1]["t"] < s1 and all(b["day"] == "2026-10-13" for b in gaps)
    real = [b for b in bars if not b.get("gap")]
    assert all(real[i]["t"] < real[i + 1]["t"] for i in range(len(real) - 1)) and bars == sorted(bars, key=lambda b: b["t"])
    assert [b for b in tl.bars("ES", 30, 0, 4e9, s0 + 3600) if b.get("gap")] == []          # the clock inside the gap: nothing after it yet
    assert len([b for b in tl.bars("ES", 1, 0, 4e9) if b.get("gap")]) == T.Timeline.GAP_SLOTS
