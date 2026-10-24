"""
workspaces.py - workspaces, as TradingView's layouts: a named place that holds the chart layout (panes, timeframes,
chart types, indicators) and the drawings per instrument. One can keep an "ES ideas" workspace with its lines and
boxes, a "backtest October" one with others, and switch; a workspace is not tied to the replay. Kept on the server
(<logs>/workspaces/<id>.json), so every window and every device in the home network sees the same.

Drawings merge rather than overwrite: every drawing carries the time of its last change (u), deletions are kept
with their time, and a window's save is merged against the stored set - the newer change wins, a deletion beats an
older change. Two windows drawing at once lose nothing, whichever saves last. After a merge the server tells the
other windows over the clock's stream ({"ws": {id, inst, origin}}) so they fetch the new state.
"""
import json
import os
import re
import threading
import time

_ID = re.compile(r"^w[0-9a-z]{4,20}$")
KEEP_DELETED_S = 7 * 86400


class Workspaces:
    def __init__(self, folder):
        self.folder = folder
        self.lock = threading.Lock()

    # ---- files
    def _path(self, wid):
        return os.path.join(self.folder, f"{wid}.json")

    def _read(self, wid):
        if not _ID.match(wid or ""):
            return None
        try:
            with open(self._path(wid), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write(self, w):
        os.makedirs(self.folder, exist_ok=True)
        w["updated"] = time.time()
        tmp = self._path(w["id"]) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(w, f, ensure_ascii=False)
        os.replace(tmp, self._path(w["id"]))

    def list(self):
        try:
            names = sorted(os.listdir(self.folder))
        except OSError:
            return []
        out = []
        for n in names:
            if n.endswith(".json"):
                w = self._read(n[:-5])
                if w:
                    out.append({"id": w["id"], "name": w["name"], "created": w.get("created", 0), "updated": w.get("updated", 0),
                                "drawings": {inst: len(d.get("list", [])) for inst, d in w.get("drawings", {}).items()}, "layout": bool(w.get("layout"))})
        return sorted(out, key=lambda w: w["created"])

    def get(self, wid):
        w = self._read(wid)
        if not w:
            raise KeyError("no such workspace")
        return w

    # ---- create, rename, duplicate, delete
    def create(self, name, layout=None, drawings=None):
        name = str(name or "").strip()[:60] or "Workspace"
        w = {"id": "w" + hex(int(time.time() * 1000))[2:], "name": name, "created": time.time(), "layout": layout if isinstance(layout, dict) else None, "drawings": {}}
        if isinstance(drawings, dict):
            for inst, lst in drawings.items():
                if isinstance(lst, list) and re.fullmatch(r"[A-Za-z0-9]+", inst):
                    w["drawings"][inst] = {"list": [d for d in lst if isinstance(d, dict) and d.get("id")], "deleted": {}}
        with self.lock:
            self._write(w)
        return w

    def rename(self, wid, name):
        with self.lock:
            w = self.get(wid)
            w["name"] = str(name or "").strip()[:60] or w["name"]
            self._write(w)
        return w

    def duplicate(self, wid, name):
        with self.lock:
            src = self.get(wid)
        return self.create(name or (src["name"] + " copy"), src.get("layout"), {inst: d.get("list", []) for inst, d in src.get("drawings", {}).items()})

    def delete(self, wid):
        with self.lock:
            self.get(wid)
            try:
                os.remove(self._path(wid))
            except OSError:
                pass
        return {"id": wid, "deleted": True}

    # ---- layout
    def set_layout(self, wid, layout):
        if not isinstance(layout, dict):
            raise ValueError("layout: an object")
        with self.lock:
            w = self.get(wid)
            w["layout"] = layout
            self._write(w)
        return {"id": wid, "ok": True}

    # ---- drawings
    def drawings(self, wid, inst):
        w = self.get(wid)
        d = w.get("drawings", {}).get(inst) or {"list": [], "deleted": {}}
        return {"id": wid, "inst": inst, "list": d.get("list", []), "deleted": d.get("deleted", {})}

    def merge(self, wid, inst, lst, deleted):
        """a window's drawings of an instrument against the stored ones; returns the merged set"""
        if not re.fullmatch(r"[A-Za-z0-9]+", inst or ""):
            raise ValueError("inst")
        if not isinstance(lst, list) or not isinstance(deleted, dict):
            raise ValueError("list and deleted")
        now = time.time() * 1000
        with self.lock:
            w = self.get(wid)
            d = w.setdefault("drawings", {}).setdefault(inst, {"list": [], "deleted": {}})
            dele = {k: float(v) for k, v in d.get("deleted", {}).items()}
            for k, v in deleted.items():
                try:
                    dele[str(k)] = max(dele.get(str(k), 0), float(v))
                except (TypeError, ValueError):
                    pass
            cut = now - KEEP_DELETED_S * 1000
            dele = {k: v for k, v in dele.items() if v > cut}
            out = {x["id"]: x for x in d.get("list", []) if isinstance(x, dict) and x.get("id")}
            for x in lst:
                if not isinstance(x, dict) or not x.get("id"):
                    continue
                cur = out.get(x["id"])
                if cur is None or float(x.get("u") or 0) >= float(cur.get("u") or 0):
                    out[x["id"]] = x
            for k, t in dele.items():
                x = out.get(k)
                if x is not None and float(x.get("u") or 0) <= t:
                    del out[k]
            d["list"], d["deleted"] = list(out.values()), dele
            self._write(w)
        return {"id": wid, "inst": inst, "list": d["list"], "deleted": d["deleted"]}
