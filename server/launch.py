"""
launch.py - what Nick.cmd (the desktop icon) runs: the replay in the browser with one double-click.

  server not running yet   -> starts it in this window and opens the replay as soon as it answers
  server running already   -> only opens it (a second double-click does no harm)
The first start leads to the settings page (no replay.cfg yet).

The window is the server's log; closing it ends it. Live data come from the
Rithmic Bridge window, which sends to http://127.0.0.1:<port>/ingest whether the server runs or not.
"""
import os
import sys
import threading
import time
import urllib.request
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import settings  # noqa: E402

PORT = settings.resolve()["PORT"]
URL = f"http://127.0.0.1:{PORT}/"
APP = URL                                 # the replay (first start: the settings page)


def server_up(timeout=1.0):
    """is our server answering on the port (not some other program)?"""
    try:
        with urllib.request.urlopen(URL + "health", timeout=timeout) as r:
            return r.read() == b"ok"
    except Exception:
        return False


def open_when_up(limit_s=20):
    end = time.time() + limit_s
    while time.time() < end:
        if server_up(0.5):
            webbrowser.open(APP)
            return
        time.sleep(0.25)


def main():
    if server_up():
        print(f"the replay runs already - opening {APP}")
        webbrowser.open(APP)
        return
    threading.Thread(target=open_when_up, daemon=True).start()
    import main as server
    server.main()


if __name__ == "__main__":
    main()
