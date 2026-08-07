# Dev shell — deliberately minimal, for the common case (run the webui):
#   python3 + flask  → web/file-server.py, the one-command local server
#
# Mobile tooling (adb, gh, libimobiledevice for install-ipa.sh, node for
# the Capacitor CLI) lives in dev/shell.nix — direnv picks it up when you
# cd into dev/.
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    python3
    python3Packages.flask
  ];
}
