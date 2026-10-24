"""specs.py: the tick of a symbol, from the table or learned from its own prices - CL in cents, an unknown one from
the finest step in its levels"""
import numpy as np

import archive as A
import specs
import timeline as T
from conftest import DATA


def test_table_and_learning():
    assert specs.tick_of("CL") == 0.01 and specs.tick_of("MCL") == 0.01 and specs.tick_of("GC") == 0.1 and specs.tick_of("ES") == 0.25
    assert specs.point_value("MES") == 5.0 and specs.spec("ZN")[0] == 1 / 64
    specs.learn("XYZ", [101.20, 101.25, 101.30, 101.45, 101.60])
    assert specs.tick_of("XYZ") == 0.05 and specs.known()["XYZ"]["source"] == "data"
    specs.learn("XYZ", [1.0, 1.001])                                   # learned once, kept
    assert specs.tick_of("XYZ") == 0.05


def test_cl_levels_keep_their_cents(tmp_path):
    """a CL day in the archive layout: prices 99.10, 99.11, ... must stay separate levels (the user's bug: with a
    0.25 grid, 25 cent-levels collapsed into one and the profile showed millions)"""
    base = tmp_path / "1m-bars" / "CL"; base.mkdir(parents=True)
    (base / "2026-10-20.meta.json").write_text('{"status":"complete"}')
    rows, lv = ["minute_utc,open,high,low,close,volume,buy_aggr,sell_aggr,delta,trades"], ["minute_utc,price,volume,buy_aggr,sell_aggr,no_aggr"]
    for i in range(3):
        m = f"2026-10-19T22:0{i}:00Z"
        rows.append(f"{m},99.10,99.14,99.08,99.12,70,40,30,10,20")
        for k, p in enumerate((99.08, 99.09, 99.10, 99.11, 99.12, 99.13, 99.14)):
            lv.append(f"{m},{p:.2f},10,6,4,0")
    (base / "2026-10-20_bars.csv").write_text("\n".join(rows) + "\n"); (base / "2026-10-20_levels.csv").write_text("\n".join(lv) + "\n")
    tl = T.Timeline(A.Archive(str(tmp_path)))
    d = tl.minutes("CL", "2026-10-20")
    assert d.tick == 0.01 and sorted(set((d.lv_p * d.tick).round(2).tolist())) == [99.08, 99.09, 99.10, 99.11, 99.12, 99.13, 99.14]
    prof = tl.profile("CL", 0, 4e9)
    assert [round(p, 2) for p, *_ in prof["levels"]] == [99.08, 99.09, 99.10, 99.11, 99.12, 99.13, 99.14] and all(v == 30 for _, v, _, _ in prof["levels"])
    lv5 = tl.levels("CL", 5, 0, 4e9)
    assert len(next(iter(lv5.values()))) == 7
