# Dev shell for oss-anki.
#
# Toolchains here:
#   1. Node + python3 — runs the tests (node --test) and the dev
#      static server (npm run serve → python3 web/serve.py).
#   2. Node + JDK + Android SDK — for the Capacitor wrapper that
#      bundles the same site as a native Android app:
#        nix-shell             # drop into the shell
#        npm install           # one-time, after entering shell
#        npm run build:android # build dist/ + npx cap sync android
#        cd android && ./gradlew assembleDebug
#        adb install android/app/build/outputs/apk/debug/app-debug.apk
#
# NOTES on iOS:
#   - The IPA *build* step still needs a Mac (Xcode + signing). Use
#     a cloud Mac / GitHub Actions runner for that.
#   - The libimobiledevice tools below let a Linux host TALK to an
#     iPhone over USB (idevice_id, ideviceinstaller, ifuse). They're
#     used by AltServer-Linux / SideStore for sideloading.
#   - usbmuxd has to run system-wide; it's NOT in this dev shell.
#     Add to /etc/nixos/configuration.nix:
#       services.usbmuxd.enable = true;
#       users.users.<you>.extraGroups = [ "usbmuxd" ];
#
# Android SDK is unfree-licensed; the import below opts in via
# config.android_sdk.accept_license = true. Drop that line if you'd
# rather review the license interactively.

{ pkgs ? import <nixpkgs> {
    config.allowUnfree = true;
    config.android_sdk.accept_license = true;
  }
}:

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

  # Pin to a recent, stable Android API level + build-tools. Bump
  # together with Capacitor major version updates.
  androidPlatformVersion = "34";
  androidBuildToolsVersion = "34.0.0";

  androidComposition = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ androidPlatformVersion ];
    buildToolsVersions = [ androidBuildToolsVersion ];
    # Skip the emulator + system images — we install on a real
    # phone via USB. Cuts the SDK download from ~5GB to a few
    # hundred MB.
    includeEmulator = false;
    includeSystemImages = false;
    # arm64-v8a covers all modern phones; keep x86_64 in case
    # someone later wants the emulator.
    abiVersions = [ "arm64-v8a" "x86_64" ];
  };
  androidSdk = androidComposition.androidsdk;
in
pkgs.mkShell {
  packages = with pkgs; [
    # ── Web app / test toolchain ───────────────────────────────
    nodejs_20               # tests (node --test) + Capacitor CLI
    python3                 # npm run serve → python3 web/serve.py

    # ── Android build toolchain ────────────────────────────────
    jdk17
    androidSdk
    android-tools           # adb, fastboot — install the APK on a
                            # USB-connected phone
    gradle                  # the project ships a wrapper, but a system
                            # gradle is handy for one-off invocations

    # ── iOS device USB communication (sideloading via
    #    AltServer-Linux / SideStore later — IPA build still needs a Mac)
    libimobiledevice
    ifuse

    # ── iLoader — sideloads IPAs onto a connected iPhone. Built
    #    via Nix from the upstream flake, so no NixOS dynamic-
    #    linking workaround is needed (steam-run/nix-ld).
    iloader

    # ── GitHub CLI (used by install-ipa.sh and install-android.sh
    #    to fetch the latest workflow artifacts — IPA from
    #    ios-build.yml, APK from android-build.yml). One-time:
    #    `gh auth login`.
    gh
  ];

  shellHook = ''
    # Capacitor / Android env wiring.
    export ANDROID_HOME="${androidSdk}/libexec/android-sdk"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export JAVA_HOME="${pkgs.jdk17.home}"

    # Gradle's Maven-bundled aapt2 isn't ELF-compatible with NixOS;
    # redirect it at the SDK's own aapt2 binary.
    export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/${androidBuildToolsVersion}/aapt2"

    # Put adb + build-tools on PATH for convenience.
    export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/${androidBuildToolsVersion}:$PATH"
  '';
}
