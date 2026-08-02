#!/usr/bin/env python3
"""oss-anki companion file server — file storage for browsers without the
File System Access API (Firefox, Safari).

Run it next to your save folder and paste the printed connect URL into the
web app (it asks on first launch):

    python3 web/file-server.py /path/to/save-folder

It also serves the app itself at http://127.0.0.1:8787/web/ — the connect
URL it prints opens that page with the token already filled in.

The API mirrors what web/http-bridge.js expects (base64 over JSON):
    GET  /api/stat          -> {exists, modified, size, label}
    GET  /api/read          -> {data: b64|null}          (oss-anki.json)
    POST /api/write         {data: b64, name?} -> {modified}
    GET  /api/media/<name>  -> {data: b64|null}          (oss-anki.media/)
    POST /api/media/<name>  {data: b64} -> {modified}

Security notes (deliberately simple, please audit):
  - Binds to 127.0.0.1 only. A random per-start token is required in the
    X-Auth header for every /api/* call — without it, any website you visit
    could otherwise talk to this server (it answers CORS preflights so the
    real app can). The token is in the printed connect URL.
  - File names are confined to the folder: anything containing a path
    separator is rejected.
  - Writes go to <name>.tmp then os.replace over the target, so readers
    (Syncthing) only ever see complete files.
"""

import base64
import os
import secrets
import sys
from pathlib import Path

from flask import Flask, jsonify, request

TOKEN = secrets.token_urlsafe(16)
PORT = 8787
SAVE = "oss-anki.json"
MEDIA = "oss-anki.media"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(REPO, "save")
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


@app.get("/api/stat")
def stat():
    p = os.path.join(ROOT, SAVE)
    exists = os.path.exists(p)
    return jsonify(
        exists=exists,
        modified=int(os.stat(p).st_mtime * 1000) if exists else 0,
        size=os.path.getsize(p) if exists else 0,
        label=os.path.basename(ROOT),
    )


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


if __name__ == "__main__":
    print(f"oss-anki save folder: {ROOT}")
    print(f"connect URL: http://127.0.0.1:{PORT}/web/index.html?token={TOKEN}")
    app.run(host="127.0.0.1", port=PORT)
