#!/usr/bin/env bash
# Download the latest successful iOS IPA artifact from the GitHub
# Actions ios-build.yml workflow, and (optionally) sideload it onto
# a connected iPhone via AltServer-Linux.
#
# Required tools (provided by shell.nix):
#   - gh           (GitHub CLI; run `gh auth login` once)
#   - unzip        (gh extracts the artifact zip itself; unzip used as fallback)
#   - libimobiledevice  (idevice_id, for finding the phone UDID)
#
# Optional: set these env vars to skip the manual sideload step.
#   ALTSERVER=/path/to/AltServer-x86_64
#   APPLE_ID=you@example.com
#   APPLE_PASS=...                              # app-specific password
#   ALTSERVER_ANISETTE_SERVER=https://ani.sidestore.io   # default if unset
#
# Usage:
#   ./install-ipa.sh                    # download + (auto-install if env set)
#   IPA_OUT=~/anki.ipa ./install-ipa.sh # save IPA to a custom path
#
# Exit codes: 0 = success, non-zero = something failed (message on stderr).

set -euo pipefail

WORKFLOW="ios-build.yml"
ARTIFACT_NAME="oss-anki-ipa"
DEFAULT_IPA_OUT="${PWD}/Memki.ipa"
IPA_OUT="${IPA_OUT:-$DEFAULT_IPA_OUT}"

# Temp dir cleanup unless IPA_KEEP=1 is set (debugging).
WORK_DIR="$(mktemp -d)"
cleanup() {
  if [ -z "${IPA_KEEP:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

# ── Preflight ─────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) not found." >&2
  echo "  Add to shell.nix: pkgs.gh" >&2
  echo "  Then run: gh auth login" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# ── Find latest successful run ────────────────────────────────────
echo "→ Looking up latest successful run of $WORKFLOW..."
RUN_ID="$(gh run list \
  --workflow="$WORKFLOW" \
  --status=success \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId' \
  || true)"
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "error: no successful runs of $WORKFLOW found." >&2
  echo "  Trigger one via the GitHub Actions tab, then re-run this script." >&2
  exit 1
fi
RUN_INFO="$(gh run view "$RUN_ID" --json displayTitle,headSha,createdAt --jq '"\(.displayTitle) · \(.headSha[0:7]) · \(.createdAt)"' || echo "$RUN_ID")"
echo "  run: $RUN_INFO"

# ── Download artifact ─────────────────────────────────────────────
echo "→ Downloading $ARTIFACT_NAME..."
gh run download "$RUN_ID" -n "$ARTIFACT_NAME" --dir "$WORK_DIR"

IPA_SRC="$(find "$WORK_DIR" -maxdepth 2 -name "*.ipa" | head -1)"
if [ -z "$IPA_SRC" ] || [ ! -f "$IPA_SRC" ]; then
  echo "error: no .ipa found in artifact contents:" >&2
  find "$WORK_DIR" -type f >&2
  exit 1
fi

mkdir -p "$(dirname "$IPA_OUT")"
cp "$IPA_SRC" "$IPA_OUT"
echo "  saved: $IPA_OUT  ($(du -h "$IPA_OUT" | cut -f1))"

# ── Optional: sideload via AltServer ──────────────────────────────
if [ -z "${ALTSERVER:-}" ] || [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_PASS:-}" ]; then
  cat <<EOF

IPA ready. Next step: install onto your iPhone.

  Quickest manual path:
    1. Plug iPhone in via USB; tap Trust on the phone.
    2. AirDrop / Syncthing / scp the .ipa to the phone's Files app.
    3. Open SideStore on the phone → "+" → pick the .ipa.

  Auto-install via AltServer-Linux: re-run with these set
    export ALTSERVER=/path/to/AltServer-x86_64
    export APPLE_ID=you@example.com
    export APPLE_PASS=your-app-specific-password
    ./install-ipa.sh
EOF
  exit 0
fi

# ── Auto-install path ─────────────────────────────────────────────
if ! command -v idevice_id >/dev/null 2>&1; then
  echo "error: idevice_id not found. Add libimobiledevice to shell.nix." >&2
  exit 1
fi

UDID="$(idevice_id -l | head -1 || true)"
if [ -z "$UDID" ]; then
  echo "error: no iPhone detected over USB." >&2
  echo "  Plug in via cable, tap Trust on the phone, ensure usbmuxd is running." >&2
  exit 1
fi
echo "→ Phone UDID: $UDID"

export ALTSERVER_ANISETTE_SERVER="${ALTSERVER_ANISETTE_SERVER:-https://ani.sidestore.io}"
echo "→ Anisette server: $ALTSERVER_ANISETTE_SERVER"

# AltServer-Linux is glibc-linked and won't run directly on NixOS;
# wrap with steam-run if available. Skipped if ALTSERVER points at
# a binary already known to work (e.g., one in nix-ld's path).
WRAP=""
if [[ "${ALTSERVER}" != /nix/store/* ]] && command -v steam-run >/dev/null 2>&1; then
  WRAP="steam-run"
fi

echo "→ Sideloading $IPA_OUT..."
$WRAP "$ALTSERVER" -u "$UDID" -a "$APPLE_ID" -p "$APPLE_PASS" "$IPA_OUT"
echo "✓ Done. On the phone: Settings → General → VPN & Device Management → trust the developer profile."
