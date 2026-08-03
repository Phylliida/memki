#!/usr/bin/env python3
"""Memki companion file server — file storage for browsers without the
File System Access API (Firefox, Safari).

Run it next to your save folder and paste the printed connect URL into the
web app (it asks on first launch):

    python3 web/file-server.py [/path/to/save-folder]   # default: ./save

It also serves the app itself at http://127.0.0.1:8787/web/ — the connect
URL it prints opens that page with the token already filled in.

The API mirrors what web/http-bridge.js expects (base64 over JSON):
    GET  /api/stat          -> {exists, modified, size, label, path}
    GET  /api/read          -> {data: b64|null}          (memki.json)
    POST /api/write         {data: b64, name?} -> {modified}
    POST /api/root          {path} -> {path, label}      (change save folder)
    GET  /api/media/<name>  -> {data: b64|null}          (memki.media/)
    POST /api/media/<name>  {data: b64} -> {modified}

Security notes (deliberately simple, please audit):
  - Binds to 127.0.0.1 only. A random token is required in the X-Auth
    header for every /api/* call — without it, any website you visit could
    otherwise talk to this server (it answers CORS preflights so the real
    app can). The token is in the printed connect URL; it's generated on
    first start and then reused (stored owner-only in the state file) so
    browsers that saved it keep working across restarts.
  - File names are confined to the folder: anything containing a path
    separator is rejected.
  - Writes go to <name>.tmp then os.replace over the target, so readers
    (Syncthing) only ever see complete files.
"""

import base64
import json
import os
import secrets
import sys
from pathlib import Path

from flask import Flask, jsonify, request

# The chosen save folder and the auth token are remembered here (gitignored)
# so they survive restarts; a CLI arg overrides the folder (and becomes the
# new remembered value).
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".file-server-state.json")


def load_state():
    try:
        with open(STATE) as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(s):
    try:
        with open(STATE, "w") as f:
            json.dump(s, f)
        os.chmod(STATE, 0o600)  # the token is a secret; owner-only
    except OSError:
        pass  # remembering is best-effort; the server still works


STATE_DATA = load_state()

# Auth token: generated once on first start, then reused (stored next to the
# save-folder path) so the connect URL — and the token browsers saved in
# localStorage — keeps working across restarts.
TOKEN = STATE_DATA.get("token") or secrets.token_urlsafe(16)
PORT = int(os.environ.get("OSS_ANKI_PORT", "8787"))
SAVE = "memki.json"
MEDIA = "memki.media"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if len(sys.argv) > 1:
    ROOT = os.path.abspath(sys.argv[1])
else:
    ROOT = os.path.abspath(os.path.expanduser(STATE_DATA.get("root") or os.path.join(REPO, "save")))


def remember():
    save_state({"root": ROOT, "token": TOKEN})


remember()
Path(ROOT).mkdir(parents=True, exist_ok=True)
# static_url_path="" serves the repo root (/web/, /src/, /vendor/...) so the
# app works fully from this server; the API lives under /api/.
app = Flask(__name__, static_folder=REPO, static_url_path="/")


@app.after_request
def cors(resp):
    # The app may be served from https://www.phylliida.dev while this server
    # is loopback — allow the cross-origin + private-network fetch.
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Auth"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


@app.before_request
def auth():
    if request.method == "OPTIONS" or not request.path.startswith("/api/"):
        return None  # preflights carry no custom headers; static files are public
    if request.headers.get("X-Auth") != TOKEN:
        return jsonify(error="bad or missing X-Auth token"), 403
    return None


def clean(name):
    """Confine a file name to its directory (no separators, no dotfiles)."""
    if not name or os.path.basename(name) != name or name.startswith("."):
        raise ValueError(f"bad file name: {name!r}")
    return name


@app.errorhandler(ValueError)
def bad_name(e):
    return jsonify(error=str(e)), 400


def read_file(p):
    if not os.path.exists(p):
        return {"data": None}
    with open(p, "rb") as f:
        return {"data": base64.b64encode(f.read()).decode()}


def write_file(p, b64):
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(base64.b64decode(b64))
    os.replace(tmp, p)  # atomic on POSIX + Windows
    return {"modified": int(os.stat(p).st_mtime * 1000)}


@app.get("/")
@app.get("/web/")
def index():
    # Flask's static handler doesn't resolve directory indexes.
    return app.send_static_file("web/index.html")


@app.get("/api/stat")
def stat():
    p = os.path.join(ROOT, SAVE)
    exists = os.path.exists(p)
    return jsonify(
        exists=exists,
        modified=int(os.stat(p).st_mtime * 1000) if exists else 0,
        size=os.path.getsize(p) if exists else 0,
        label=os.path.basename(ROOT),
        path=ROOT,
    )


@app.post("/api/root")
def set_root():
    global ROOT
    p = os.path.abspath(os.path.expanduser(request.json["path"]))
    os.makedirs(p, exist_ok=True)  # typing a new path creates the folder
    migrate(p)
    ROOT = p
    remember()
    return jsonify(path=ROOT, label=os.path.basename(ROOT))


@app.get("/api/read")
def read():
    return jsonify(**read_file(os.path.join(ROOT, SAVE)))


@app.post("/api/write")
def write():
    name = clean(request.json.get("name", SAVE))
    return jsonify(**write_file(os.path.join(ROOT, name), request.json["data"]))


@app.get("/api/media/<name>")
def read_media(name):
    return jsonify(**read_file(os.path.join(ROOT, MEDIA, clean(name))))


@app.post("/api/media/<name>")
def write_media(name):
    os.makedirs(os.path.join(ROOT, MEDIA), exist_ok=True)
    return jsonify(**write_file(os.path.join(ROOT, MEDIA, clean(name)), request.json["data"]))


OLD_NAMES = [("oss-anki.json", SAVE), ("oss-anki-backup.json", "memki-backup.json"), ("oss-anki.media", MEDIA)]


def migrate(root):
    """One-time rename from pre-rename (oss-anki.*) file names."""
    for old, new in OLD_NAMES:
        old_p, new_p = os.path.join(root, old), os.path.join(root, new)
        if os.path.exists(old_p) and not os.path.exists(new_p):
            os.rename(old_p, new_p)


if __name__ == "__main__":
    migrate(ROOT)
    print(f"Memki save folder: {ROOT}")
    print(f"connect URL: http://127.0.0.1:{PORT}/web/?token={TOKEN}")
    app.run(host="127.0.0.1", port=PORT)
