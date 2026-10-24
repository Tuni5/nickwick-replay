"""
ticks.py - every print of a live feed as the Rithmic Bridge sends it ("ticks": [[epoch us, price, size, side], ...],
side +1 buyer / -1 seller / 0 unknown), in time order, for the simulated broker's paper trading on the live session.
Kept in numpy arrays for keep_h hours (a busy ES session has well over a million prints; Python tuples would not do).
"""
import threading

import numpy as np


class TickStore:
    def __init__(self, keep_h=24.0):
        self.keep_s = keep_h * 3600
        self.lock = threading.Lock()
        self.cap = 0
        self.start = self.n = 0
        self.t = self.px = self.sz = self.side = None

    def add(self, ticks):
        rows = [r for r in ticks if r is not None and len(r) >= 3]
        if not rows:
            return
        t = np.array([float(r[0]) / 1e6 for r in rows])
        px = np.array([float(r[1]) for r in rows], np.float64)
        sz = np.array([float(r[2]) for r in rows], np.float32)
        side = np.array([int(r[3]) if len(r) > 3 else 0 for r in rows], np.int8)
        self._append(t, px, sz, side)

    def _append(self, t, px, sz, side):
        """arrays of epoch s, price, size, side onto the store; kept sorted by time, older than keep_h dropped"""
        with self.lock:
            k = t.size
            if self.n + k > self.cap:
                live = self.n - self.start
                cap = max(65536, 2 * (live + k))
                nt = np.empty(cap); npx = np.empty(cap); nsz = np.empty(cap, np.float32); nsd = np.empty(cap, np.int8)
                if live:
                    nt[:live] = self.t[self.start:self.n]; npx[:live] = self.px[self.start:self.n]
                    nsz[:live] = self.sz[self.start:self.n]; nsd[:live] = self.side[self.start:self.n]
                self.t, self.px, self.sz, self.side, self.cap, self.start, self.n = nt, npx, nsz, nsd, cap, 0, live
            self.t[self.n:self.n + k] = t; self.px[self.n:self.n + k] = px
            self.sz[self.n:self.n + k] = sz; self.side[self.n:self.n + k] = side
            self.n += k
            late = self.n - k > self.start and t[0] < self.t[self.n - k - 1]       # a late batch
            if late or (k > 1 and np.any(np.diff(t) < 0)):                       # or one out of order in itself
                o = np.argsort(self.t[self.start:self.n], kind="stable") + self.start
                self.t[self.start:self.n] = self.t[o]; self.px[self.start:self.n] = self.px[o]
                self.sz[self.start:self.n] = self.sz[o]; self.side[self.start:self.n] = self.side[o]
            cut = self.t[self.n - 1] - self.keep_s
            self.start += int(np.searchsorted(self.t[self.start:self.n], cut, "left"))

    def first(self):
        with self.lock:
            return float(self.t[self.start]) if self.n > self.start else None
