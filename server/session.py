"""
session.py - time, the way the CME and the Rithmic Bridge's archive see it.

A trading day ("session") runs from 18:00 New York the evening before until 17:00 New York, and is named by its trade
date, the date of its 17:00 end. The archive writes one file set per session. The regular hours (RTH) of index futures
are 09:30 to 16:00 New York on the trade date. New York time is computed here without a time zone database so the
tool runs on a bare Windows Python: daylight saving from the second Sunday of March 02:00 to the first Sunday of
November 02:00 (US rules since 2007).

Timeframe buckets are anchored at the session start, so a 30-minute bar starts 18:00, 18:30, ... and a 4-hour bar
18:00, 22:00, 02:00, ...; the daily bar is the session. A bucket is named by its start (UTC epoch seconds).
"""
from datetime import date, datetime, timedelta, timezone

DAY = 86400


def _nth_sunday(y, month, n):
    d = date(y, month, 1)
    return d + timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))


def ny_offset(utc):
    """hours New York lies behind UTC at this moment: 4 in summer time, 5 in winter"""
    y = datetime.fromtimestamp(utc, timezone.utc).year
    start = datetime.combine(_nth_sunday(y, 3, 2), datetime.min.time(), timezone.utc).timestamp() + 7 * 3600    # 02:00 EST
    end = datetime.combine(_nth_sunday(y, 11, 1), datetime.min.time(), timezone.utc).timestamp() + 6 * 3600     # 02:00 EDT
    return 4 if start <= utc < end else 5


def ny_wall(utc):
    """UTC epoch seconds -> New York wall-clock seconds (as if New York were UTC)"""
    return utc - ny_offset(utc) * 3600


def trade_date(utc):
    """the session a moment belongs to, as 'YYYY-MM-DD': from 18:00 New York the day belongs to the next date"""
    return datetime.fromtimestamp(((int(ny_wall(utc)) + 6 * 3600) // DAY) * DAY, timezone.utc).strftime("%Y-%m-%d")


def _utc_of_ny(wall):
    """New York wall-clock seconds -> UTC epoch (the offset found at that moment)"""
    guess = wall + 4 * 3600
    return int(wall + ny_offset(guess) * 3600)


def bounds(td):
    """[start, end) of the session with trade date td, UTC epoch seconds: 18:00 New York the evening before to 17:00"""
    d0 = datetime.fromisoformat(td).replace(tzinfo=timezone.utc).timestamp()
    return _utc_of_ny(d0 - 6 * 3600), _utc_of_ny(d0 + 17 * 3600)


def rth(td):
    """[09:30, 16:00) New York on the trade date, UTC epoch seconds"""
    d0 = datetime.fromisoformat(td).replace(tzinfo=timezone.utc).timestamp()
    return _utc_of_ny(d0 + 9.5 * 3600), _utc_of_ny(d0 + 16 * 3600)


def bucket_start(t, tf, start):
    """the start of the tf-minute bucket a moment t falls into, buckets anchored at the session start"""
    if tf >= 1440:
        return start
    w = tf * 60
    return start + ((int(t) - start) // w) * w


def neighbours(td):
    """the calendar dates around a trade date, as strings"""
    d = date.fromisoformat(td)
    return [(d + timedelta(days=k)).isoformat() for k in (-1, 0, 1)]
