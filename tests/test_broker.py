"""broker.py: the rules on a hand-made tape, then the path through the real day's 1-second bars"""
import numpy as np

import broker as B
import reference as R
import session
from conftest import DAY


def prints(rows):
    """[(t, price, side), ...] -> Prints (size 1 each)"""
    t, px, sd = zip(*rows)
    return B.Prints(np.array(t, float), np.array(px, float), np.ones(len(rows), np.float32), np.array(sd, np.int8), "tape")


TAPE = prints([(1, 100.00, -1), (2, 100.25, +1), (3, 100.00, -1), (4, 99.75, -1), (5, 100.25, +1),
               (6, 100.75, +1), (7, 101.25, +1), (8, 101.00, -1), (9, 102.00, +1), (10, 100.50, -1)])


def order(t, side, kind, qty=1, price=None, oid="a", **kw):
    return {"op": "order", "t": t, "id": oid, "side": side, "type": kind, "qty": qty, "price": price, **kw}


def test_market_takes_the_next_print_on_its_side():
    st = B.compute([order(1.5, +1, "market")], TAPE, 10)
    assert st["fills"][0]["price"] == 100.25 and st["fills"][0]["t"] == 2 and st["pos"] == 1
    st = B.compute([order(1.5, -1, "market")], TAPE, 10)
    assert st["fills"][0]["price"] == 100.00 and st["fills"][0]["t"] == 3


def test_a_resting_limit_fills_only_when_traded_through():
    st = B.compute([order(0.5, +1, "limit", price=100.00)], TAPE, 3.5)
    assert st["pos"] == 0                                                  # prints at 100.00 do not fill it
    st = B.compute([order(0.5, +1, "limit", price=100.00)], TAPE, 4.5)
    assert st["pos"] == 1 and st["fills"][0]["price"] == 100.00 and st["fills"][0]["t"] == 4   # 99.75 trades through
    st = B.compute([order(2.5, +1, "limit", price=101.00)], TAPE, 10)       # placed above the market: marketable
    assert st["fills"][0]["price"] == 100.00 and st["fills"][0]["t"] == 3


def test_a_stop_fills_at_the_triggering_print():
    st = B.compute([order(0.5, +1, "stop", price=101.00)], TAPE, 10)
    assert st["fills"][0]["price"] == 101.25 and st["fills"][0]["t"] == 7   # slippage: the print that crossed it


def test_bracket_target_cancels_stop_and_books_the_trade():
    acts = [order(0.5, +1, "market", qty=2), {"op": "bracket", "t": 2.5, "sl": 99.50, "tp": 101.50}]
    st = B.compute(acts, TAPE, 6.5)
    assert st["pos"] == 2 and {o["id"] for o in st["orders"]} == {"sl", "tp"}
    st = B.compute(acts, TAPE, 10)
    assert st["pos"] == 0 and st["orders"] == [] and st["bracket"] == {"sl": None, "tp": None}
    tr = st["trades"][0]
    assert (tr["entry"], tr["exit"], tr["exit_by"], tr["ticks"], tr["usd"]) == (100.25, 101.50, "tp", 5.0, 125.0)


def test_flip_flatten_and_jump_back():
    acts = [order(0.5, +1, "market", qty=1, oid="a"), order(2.5, -1, "market", qty=3, oid="b"), {"op": "flatten", "t": 6.5}]
    st = B.compute(acts, TAPE, 10)
    assert st["trades"][0]["qty"] == 1 and st["trades"][1]["side"] == "short" and st["pos"] == 0
    assert st["trades"][1]["exit_by"] == "flatten" and st["trades"][1]["exit"] == 101.25
    assert B.compute(acts, TAPE, 2)["pos"] == 1                             # nothing after the clock
    assert B.compute(acts, TAPE, 0.4)["orders"] == []


def test_attached_bracket_and_modify():
    acts = [order(0.5, +1, "limit", price=100.00, oid="x", sl=99.00, tp=101.00),
            {"op": "modify", "t": 1.5, "id": "x", "tp": 102.00, "sl": None}]
    st = B.compute(acts, TAPE, 3.5)
    assert st["orders"][0]["tp"] == 102.00 and "sl" not in st["orders"][0] and st["pos"] == 0
    st = B.compute(acts, TAPE, 6)
    assert st["pos"] == 1 and st["bracket"] == {"sl": None, "tp": 102.00}
    acts = [order(0.5, +1, "limit", price=99.00, oid="x"), {"op": "modify", "t": 3.5, "id": "x", "price": 100.00}]
    st = B.compute(acts, TAPE, 10)
    assert st["fills"][0]["t"] == 4 and st["fills"][0]["price"] == 100.00


def test_the_book_drops_what_lay_later(tmp_path):
    book = B.Book(str(tmp_path))
    book.add("ES.1m@x", order(5, +1, "market", oid="late"))
    assert book.add("ES.1m@x", order(2, -1, "market", oid="early")) == 1
    assert [a["id"] for a in B.Book(str(tmp_path)).actions("ES.1m@x")] == ["early"]


def test_the_path_through_the_real_seconds(arch):
    """the real day without a tick export: the broker walks each second open -> low -> high -> close (or
    open -> high -> low -> close), a tick a step, with the second's volume spread over the steps"""
    secs = arch.seconds("ES", DAY)
    pr = B.Prints.from_seconds(secs, 0.25)
    rows = R.seconds(DAY)
    assert abs(float(pr.sz.sum()) - sum(r[5] for r in rows)) < 1e-3 and "1-second" in pr.source
    t0, o, h, l, c, v, bu, se = rows[0]                                      # 22:00:00: o 7873 h 7873 l 7869.5 c 7870
    assert (o, h, l, c) == (7873.0, 7873.0, 7869.5, 7870.0)
    first = pr.px[pr.t < t0 + 1].tolist()
    want = [7873.0] + [7873.0 - 0.25 * i for i in range(1, 15)] + [7869.5 + 0.25 * i for i in range(1, 3)]   # closed down: open, high, low, close
    assert first == want and all(x >= t0 and x < t0 + 1 for x in pr.t[:len(first)])
    assert pr.side[0] == 0 and (pr.side[1:15] == -1).all() and (pr.side[15:17] == 1).all()
    r0 = session.rth(DAY)[0]
    st = B.compute([order(r0 + 0.5, +1, "market")], pr, r0 + 60)
    f = st["fills"][0]
    assert f["t"] > r0 + 0.5 and f["side"] == 1                               # a step of that second, after the click
    k = int(np.searchsorted(pr.t, r0 + 0.5, "right"))
    j = k + int(np.argmax(pr.side[k:] >= 0))
    assert f["price"] == pr.px[j] and f["t"] == pr.t[j]
