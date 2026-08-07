# Mobile-dev shell — everything from the root shell (python3 + flask for
# the webui) plus the phone tooling:
#   adb (android-tools)  → install the APK on a USB-connected Android phone
#   gh                   → download the iOS IPA artifact (install-ipa.sh)
#   libimobiledevice     → find the iPhone UDID for install-ipa.sh sideloads
#   nodejs               → Capacitor CLI (npx cap sync, build:android, ...)
#
# Direnv loads this when you cd into dev/ (dev/.envrc does `use nix`).
{ pkgs ? import <nixpkgs> {} }:

let
  # iLoader — Linux iOS sideloader (nab138/iloader on GitHub),
  # pulled in via flake. Requires flakes enabled in your nix config:
  #   nix.settings.experimental-features = [ "nix-command" "flakes" ];
  # Pinned: HEAD commit 9763382 ("Update isideload to apple-codesign-quick
  # version", 2026-08-01) breaks evaluation — its flake's importCargoLock
  # has no outputHash for the apple-codesign-0.1.0 git dependency. This
  # pin is the last commit before that change. To unpin, drop the rev
  # suffix and check upstream has fixed the cargo lock first.
  iloader = (builtins.getFlake "github:nab138/iloader/5b3e750edff5826efaf6ff4bc85d75796ff6838f").packages.${pkgs.stdenv.hostPlatform.system}.default;
in
pkgs.mkShell {
  packages = with pkgs; [
    python3
    python3Packages.flask
    android-tools
    gh
    libimobiledevice
    nodejs_20

    # iLoader — sideloads IPAs onto a connected iPhone. Built
    # via Nix from the upstream flake, so no NixOS dynamic-
    # linking workaround is needed (steam-run/nix-ld).
    iloader
  ];
}
