r"""
bridge_capture.py - records what the Rithmic Bridge sends, and passes it on to the replay server.

  .venv\Scripts\python bridge_capture.py            (anywhere; no packages needed)

Then, in the Rithmic Bridge, set the Viewer URL to   http://127.0.0.1:8022/ingest   (instead of 8021) and let it run
for two or three minutes with trades going on. Everything the bridge sends is written to bridge_capture.log next to
this script - the first messages in full (long lists cut to their first three entries), after that one line per
message with its shape - and forwarded to http://127.0.0.1:8021/ingest, so the replay keeps working meanwhile.
Afterwards set the Viewer URL back to 8021 and send the log.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN, FORWARD = 8022, "http://127.0.0.1:8021/ingest"
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge_capture.log")
FULL = 8                                   # messages written in full
state = {"n": 0, "shapes": set()}


def trim(x, depth=0):
    """long lists cut to three entries, nested"""
    if isinstance(x, list):
        if len(x) <= 6:                                    # a row (a tick, a level) stays whole
            return [trim(v, depth + 1) for v in x]
        return [trim(v, depth + 1) for v in x[:3]] + [f"... {len(x)} entries in all"]
    if isinstance(x, dict):
        return {k: trim(v, depth + 1) for k, v in x.items()}
    return x


def shape(msg):
    parts = []
    for k, v in msg.items():
        if isinstance(v, list):
            first = v[0] if v else None
            inner = (f"[{len(first)} fields: {first}]" if isinstance(first, list) else f"{{{', '.join(first.keys())}}}" if isinstance(first, dict) else repr(first)) if v else "empty"
            parts.append(f"{k}=list({len(v)}, first={inner})")
        elif isinstance(v, dict):
            parts.append(f"{k}={{{', '.join(v.keys())}}}")
        else:
            parts.append(f"{k}={v!r}")
    return ", ".join(parts)


def log(line):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line[:200])


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        stamp = time.strftime("%H:%M:%S")
        state["n"] += 1
        try:
            msg = json.loads(raw)
        except ValueError:
            log(f"{stamp} #{state['n']} {self.path} NOT JSON ({n} bytes): {raw[:300]!r}")
            msg = None
        if msg is not None:
            sh = shape(msg) if isinstance(msg, dict) else f"top level is {type(msg).__name__}"
            log(f"{stamp} #{state['n']} {self.path} {n} bytes | {sh}")
            if state["n"] <= FULL or (isinstance(msg, dict) and frozenset(msg.keys()) not in state["shapes"]):
                log("    FULL: " + json.dumps(trim(msg), ensure_ascii=False))
            if isinstance(msg, dict):
                state["shapes"].add(frozenset(msg.keys()))
        # forward
        code, body = 502, b"replay server not reachable"
        try:
            req = urllib.request.Request(FORWARD, data=raw, method="POST", headers={"Content-Type": self.headers.get("Content-Type", "application/json")})
            with urllib.request.urlopen(req, timeout=5) as r:
                code, body = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, body = e.code, e.read()
        except Exception as ex:
            body = str(ex).encode()
        log(f"    -> server answered {code} {body[:120]!r}")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        body = b"bridge_capture: send the bridge here (POST /ingest); log: " + LOG.encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"\n==== capture started {time.strftime('%Y-%m-%d %H:%M:%S')} ====\n")
    print(f"listening on http://127.0.0.1:{LISTEN}/ingest, forwarding to {FORWARD}")
    print(f"log: {LOG}")
    print("in the Rithmic Bridge: Viewer URL = http://127.0.0.1:8022/ingest - afterwards back to 8021. Ctrl+C stops.")
    try:
        ThreadingHTTPServer(("127.0.0.1", LISTEN), H).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
