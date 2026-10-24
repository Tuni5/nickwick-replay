"""
settings.py - the settings of this machine in one place, for the server and the settings page (config.html).

The tool only reads and shows (docs/LANDSCAPE.md): the Rithmic Bridge window acquires the data, so the tool keeps no
login and no API key. What it needs:

  DATA_DIR         the Rithmic Bridge's archive base (1m-bars, 1s-bars, ticks): the charts' data
  SCREENSHOT_DIR   where snapshots are saved
  PORT             where the server listens; the bridge sends live data to http://127.0.0.1:<port>/ingest

Each folder defaults to a subfolder of DATA_ROOT (candles, screenshots); a path set explicitly wins. Stored in
replay.cfg in the repository root (git-ignored), KEY=VALUE lines; the settings page writes it, keys it does not know
are kept as they are. A trainer.cfg of the older tool next to it is read once for its DATA_DIR when replay.cfg does not
exist yet.
"""
import os
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                                   # repository root
CONFIG_FILE = os.environ.get("REPLAY_CFG") or os.path.join(ROOT, "replay.cfg")     # REPLAY_CFG: tests
OLD_CONFIG = os.path.join(ROOT, "trainer.cfg")

# key: (group, label, kind, restart needed, help). kind: path | int | bool
FIELDS = {
    "DATA_DIR": ("folders", "Rithmic archive", "path", False,
                 "The Rithmic Bridge's archive folder, with 1m-bars and 1s-bars in it "
                 "(e.g. E:\\TradingData\\marketdata\\rithmic-bars-data). Default: <data folder>\\candles."),
    "SCREENSHOT_DIR": ("folders", "Snapshots", "path", False,
                       "Where \u201cSave to the screenshot folder” puts the images (PNG, named by instrument, "
                       "timeframes and replay time). Default: <data folder>\\screenshots."),
    "DATA_ROOT": ("folders", "Data folder", "path", False,
                  "Default for the folders above when they are not set one by one."),
    "PORT": ("server", "Port", "int", True, "The Rithmic Bridge sends to http://127.0.0.1:<port>/ingest. "
             "Takes effect after a restart of the server."),
    "LAN": ("server", "Reachable in the home network", "bool", True,
            "1 = the server listens on every address of this machine; the page is then reachable e.g. on an iPad at "
            "http://<IP of this machine>:<port>/ (Windows asks once to allow Python through the firewall). "
            "0 = this machine only. Takes effect after a restart."),
}
HIDDEN = ("EXPIRE", "STALE")                                    # kept as they are in replay.cfg, not on the page
FOLDERS = ("DATA_DIR",)                                         # the ones that must exist


def read_kv(path):
    """KEY=VALUE lines, # comments; a missing file = nothing. Keys upper-case."""
    values = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip().upper()] = value.strip()
    return values


def write_kv(path, changes):
    """set or remove keys (value None or "" = remove) in a KEY=VALUE file, keeping every other line and comment as it
    is. Written to a temporary file first, then swapped in."""
    lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    todo = {k.upper(): v for k, v in changes.items()}
    out = []
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            key = s.split("=", 1)[0].strip().upper()
            if key in todo:
                v = todo.pop(key)
                if v not in (None, ""):
                    out.append(f"{key}={v}")
                continue
        out.append(line)
    for key, v in todo.items():
        if v not in (None, ""):
            out.append(f"{key}={v}")
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", dir=folder)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")
    os.replace(tmp, path)


def load(path=None):
    """the raw replay.cfg; without one, the older tool's trainer.cfg next to it (its archive folder carries over)"""
    p = path or CONFIG_FILE
    if not os.path.exists(p) and path is None and os.path.exists(OLD_CONFIG):
        old = read_kv(OLD_CONFIG)
        return {k: v for k, v in old.items() if k in ("DATA_DIR", "DATA_ROOT", "SCREENSHOT_DIR", "PORT")}
    return read_kv(p)


def resolve(cfg=None):
    """the effective settings: what replay.cfg says, with every default filled in. Paths may not exist."""
    cfg = load() if cfg is None else cfg
    root = cfg.get("DATA_ROOT") or os.path.join(ROOT, "data")
    return {
        "DATA_ROOT": root,
        "DATA_DIR": cfg.get("DATA_DIR") or os.path.join(root, "candles"),
        "SCREENSHOT_DIR": cfg.get("SCREENSHOT_DIR") or os.path.join(root, "screenshots"),
        "PORT": int(cfg.get("PORT") or 8021),
        "LAN": str(cfg.get("LAN") or "0").strip().lower() in ("1", "true", "yes", "ja"),
        "EXPIRE": int(cfg.get("EXPIRE") or 12),
        "STALE": int(cfg.get("STALE") or 6),
    }


def save(changes, path=None):
    """write settings (only the keys the page may set); "" = back to the default. Returns the keys that need a restart."""
    bad = [k for k in changes if k not in FIELDS]
    if bad:
        raise KeyError(", ".join(bad))
    for k, v in changes.items():
        if v in (None, ""):
            continue
        if FIELDS[k][2] == "int":
            int(v)
        elif FIELDS[k][2] == "bool":
            if str(v).strip().lower() not in ("0", "1", "true", "false", "yes", "no", "ja", "nein"):
                raise ValueError(f"{k}: 0 or 1")
        elif "\n" in str(v) or "\r" in str(v):
            raise ValueError(f"{k}: one line only")
    before = load(path)
    target = path or CONFIG_FILE
    if not os.path.exists(target):
        with open(target, "w", encoding="utf-8", newline="\n") as f:
            f.write("# replay.cfg - settings of this machine, written by the settings page (http://127.0.0.1:8021/config.html).\n"
                    "# Editing by hand works too: KEY=VALUE, one per line.\n")
    write_kv(target, {k: (str(v).strip() if v is not None else "") for k, v in changes.items()})
    return [k for k in changes if FIELDS[k][3] and before.get(k, "") != str(changes[k] or "").strip()]
