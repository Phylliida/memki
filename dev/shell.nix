# Mobile-dev shell — everything from the root shell (python3 + flask for
# the webui) plus the phone tooling:
#   adb (android-tools)  → install the APK on a USB-connected Android phone
#   gh                   → download the iOS IPA artifact (install-ipa.sh)
#   libimobiledevice     → find the iPhone UDID for install-ipa.sh sideloads
#   nodejs               → Capacitor CLI (npx cap sync, build:android, ...)
#
# Direnv loads this when you cd into dev/ (dev/.envrc does `use nix`).
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    python3
    python3Packages.flask
    android-tools
    gh
    libimobiledevice
    nodejs_20
  ];
}
