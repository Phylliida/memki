# Dev shell — deliberately minimal:
#   python3 + flask    → web/file-server.py, the one-command local server
#   adb                → install the APK on a USB-connected Android phone
#   gh                 → download the iOS IPA artifact (install-ipa.sh)
#   libimobiledevice   → find the iPhone UDID for install-ipa.sh sideloads
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    python3
    python3Packages.flask
    android-tools
    gh
    libimobiledevice
  ];
}
