# Shipping Memki on F-Droid

Everything we had to do to get Memki (`dev.phylliida.memki`) accepted into the
F-Droid build pipeline, including reproducible builds with upstream signing.
This documents the final state plus every pitfall we hit, so future releases
(and future apps) don't have to rediscover them.

## The moving parts

```
GitHub: Phylliida/memki                     fdroiddata fork (GitLab)
├─ android/app/build.gradle  ← versionName/versionCode = release truth
├─ fastlane/metadata/android/en-US/  ← store listing (F-Droid reads this)
├─ .github/workflows/android-release.yml  ← builds + signs + publishes releases
└─ git tag vX.Y.Z            ← what F-Droid builds from
                                            │
                                            └─ metadata/dev.phylliida.memki.yml
                                               (recipe: how to build, where the
                                               signed APK is, which cert to expect)
```

F-Droid's buildserver clones the repo at the pinned commit, builds the APK
from source, downloads our CI-signed APK, proves byte-identity (after moving
the signature over with apksigcopier), and ships **our** signature. Users can
switch between F-Droid and GitHub Releases without reinstalling.

## 1. Inclusion-policy compliance (repo-side)

Per https://f-droid.org/en/docs/Inclusion_Policy/ :

- **License**: MIT (OSI-approved). Vendored JS deps in `vendor/` all carry
  FLOSS licenses (MIT/BSD/Apache), noted in `vendor/README.md`.
- **No proprietary anything**: no tracking, ads, analytics, Firebase, Play
  Services. We removed the Capacitor template's leftover
  `com.google.gms:google-services` buildscript classpath and its conditional
  `apply plugin` block — unused, and F-Droid's scanner flags `com.google.gms`
  artifacts on sight.
- **Trusted repos only**: `google()` + `mavenCentral()` are both on F-Droid's
  allowlist, so AndroidX/Capacitor deps are fine.
- **Permissions**: the manifest had `INTERNET` (Capacitor template default).
  The app is fully offline — content renders from bundled assets via the
  WebView asset loader (no sockets), save-folder access goes through SAF —
  so we deleted it. The APK now has zero `<uses-permission>` entries, which
  makes the "no network access" store claim literally true.
- **No binary blobs in git**: untracked the committed `oss-anki.apk`, and
  `vendor/sqljs/sql-wasm.wasm` isn't in git either (postinstall restores it
  from the pinned npm sql.js package — see pitfall #3).
  `.gitignore` also blocks `*.keystore` (with an explicit exception for the
  committed *debug* keystore, which is public by design).
- **Track Capacitor's generated cordova gradle files** — see pitfall #2.

## 2. Store metadata lives in the repo (Fastlane)

F-Droid scrapes the listing from the app repo (at the build commit), so
summary/description do NOT go in fdroiddata. Layout:

```
fastlane/metadata/android/en-US/
├── short_description.txt      # ≤80 chars
├── full_description.txt       # ≤4000 chars
├── changelogs/1.txt … N.txt   # named by versionCode
└── images/
    ├── icon.png
    └── phoneScreenshots/*.jpg
```

Important: the scraping happens **from the tagged build commit**, so
screenshots/description changes only reach F-Droid on the next version bump.

## 3. The fdroiddata metadata file

`metadata/dev.phylliida.memki.yml` in the fork, final form:

```yaml
Categories:
  - Science & Education
License: MIT
AuthorName: Phylliida Dev
SourceCode: https://github.com/Phylliida/memki
IssueTracker: https://github.com/Phylliida/memki/issues
Changelog: https://github.com/Phylliida/memki/releases

AutoName: Memki

RepoType: git
Repo: https://github.com/Phylliida/memki
Binaries: https://github.com/Phylliida/memki/releases/download/v%v/memki-%v.apk

Builds:
  - versionName: 1.0.7
    versionCode: 8
    commit: 6c4e281de79f07edc34714e7d813d9a41e23cba4
    subdir: android/app
    sudo:
      - echo "deb https://deb.debian.org/debian forky main" > /etc/apt/sources.list.d/forky.list
      - apt-get update
      - apt-get install -y -t forky nodejs npm
    gradle:
      - yes
    build:
      - cd ../..
      - npm ci
      - bash scripts/build-capacitor.sh
      - npx cap sync android

AllowedAPKSigningKeys: 437ac265133b4633ba12bd3c889b04f8597911e99482078bf09a5d65326cc3ae

AutoUpdateMode: Version
UpdateCheckMode: Tags
CurrentVersion: 1.0.7
CurrentVersionCode: 8
```

Field notes (each of these cost us something to learn):

- **`commit:`**: full hash, not a tag name (fdroid's docs ask for hashes).
- **`subdir: android/app`** — the directory Gradle generates its `build/`
  output in (linsui's review: "the subdir should be set to the path where
  the build directory will be generated in"). Every script phase
  (`init`/`prebuild`/`build`) **runs in the subdir**, hence `cd ../..` first
  to reach the repo root for `npm ci`/`cap sync`. Gradle run in `android/app`
  discovers the multi-project build via the parent `settings.gradle` and
  builds just the `:app` subproject.
- **No `output:`** — with subdir on the app module, fdroid auto-finds the
  APK in `<subdir>/build/outputs/apk/release/`. Setting `output:` switches
  the output method to `raw` and bypasses that auto-detection, so reviewers
  ask for it to be dropped.
- **`build:` runs after the source scan; `init`/`prebuild` run before it.**
  `npm ci` creates `node_modules` full of blobs, so it must be in `build:`,
  not earlier. (`scanignore`/`scandelete` paths are relative to the repo
  root, not the subdir.)
- **`sudo:`**: the buildserver is Debian; current fdroiddata convention pulls
  `nodejs`/`npm` from the `forky` suite (newer than the base image's).
- **Prebuilt binaries**: keep none in git. `vendor/sqljs/sql-wasm.wasm`
  (compiled SQLite, needed at runtime for .apkg interop) is restored from
  the lockfile-pinned npm sql.js package by an npm `postinstall` script —
  the source scan runs before `npm ci`, so the scanner never sees it, and
  both our CI and the buildserver get byte-identical bytes (RB unaffected).
- **`Binaries:`** turns on reproducible builds. `%v` expands to versionName.
  Lint then **requires `AllowedAPKSigningKeys`** (SHA-256 fingerprint of the
  release cert, lowercase hex, no colons) so the signature is pinned.
- **No comments, canonical field order** — CI runs `fdroid rewritemeta` and
  fails on any diff. Always canonicalize locally before committing
  (`fdroid rewritemeta dev.phylliida.memki`), then `fdroid lint`.
- **`AutoUpdateMode: Version` + `UpdateCheckMode: Tags`**: future releases
  are picked up automatically from new tags.

## 4. Reproducible builds (RB)

The deal: F-Droid builds from source; if the unsigned output is
byte-identical to ours, they copy our signature onto their build and ship
that. Same signature everywhere = users can hop channels freely.

### What it took

1. **A release keystore** (user-owned, NOT in git):

   ```bash
   keytool -genkeypair -v -keystore memki-release.keystore -alias memki \
     -keyalg RSA -keysize 2048 -validity 20000
   ```

   `-validity` is in days; there is no "infinite" (X.509 caps at year 9999),
   and Android/F-Droid don't enforce expiry on update signature checks
   anyway. Losing the keystore or password is the real risk — back it up.

2. **Four repository-level Actions secrets** (Settings → Secrets and
   variables → Actions → *Repository secrets* — NOT an environment, see
   pitfall #5): `MEMKI_KEYSTORE_B64` (`base64 -w0 memki-release.keystore`),
   `MEMKI_KEYSTORE_PASSWORD`, `MEMKI_KEY_ALIAS`, `MEMKI_KEY_PASSWORD`.

3. **`.github/workflows/android-release.yml`** — triggers on every `main`
   push (see pitfall #4), reads `versionName` from `build.gradle`, skips if
   that release already exists, otherwise: `npm ci` →
   `scripts/build-capacitor.sh` → `npx cap sync android` →
   `gradlew assembleRelease` (unsigned) → `apksigner sign` →
   `gh release create` (creates the tag too, at the pushed commit).

4. **Environment parity** — the hard part. Three environments must produce
   identical bytes (see pitfalls #7/#8): same Gradle (wrapper 8.2.1), same
   AGP (8.2.1), same build-tools (34.0.0), same JDK major (21), same
   apksigner (34.0.0).

### Verifying RB locally before involving CI

```bash
python3 -m venv tmp/fdroidenv && tmp/fdroidenv/bin/pip install fdroidserver
# two pip-packaging quirks (fdroidserver 2.4.5):
curl -sL "https://gitlab.com/fdroid/fdroidserver/-/raw/2.4.5/gradlew-fdroid" \
  -o tmp/fdroidenv/lib/python3.13/site-packages/gradlew-fdroid
chmod +x tmp/fdroidenv/lib/python3.13/site-packages/gradlew-fdroid
sed -i '1s|.*|#!/usr/bin/env bash|' tmp/fdroidenv/lib/python3.13/site-packages/gradlew-fdroid
```

Then in the fdroiddata fork, drop in a local `config.yml` (never commit it;
a copy is parked at `tmp/fdroid-local-config.yml`):

```yaml
sdk_path: <path-to-android-sdk>
build_tools: "34.0.0"
java_paths:
  '21': <path-to-jdk-21>
make_current_version_link: false
```

and run:

```bash
cd tmp/fdroiddata
JAVA_HOME=<jdk-21> ../fdroidenv/bin/fdroid lint dev.phylliida.memki
JAVA_HOME=<jdk-21> ../fdroidenv/bin/fdroid build -t -v --no-tarball dev.phylliida.memki
```

NixOS local-run notes (all three bit us on the 1.0.7 verify):

- `JAVA_HOME` must be a nix-store JDK (the config's `java_paths` entry);
  an extracted temurin tarball won't exec on NixOS.
- Put `$JAVA_HOME/bin` on `PATH` too — fdroid's apksigner wrapper script
  does `exec java` at the signature-verify step and fails with
  `exec: java: not found` otherwise.
- `~/.gradle/gradle.properties` needs
  `android.aapt2FromMavenOverride=<sdk>/build-tools/34.0.0/aapt2`, or AGP
  runs the maven-cached aapt2 which dies with `Exec failed, error: 2`
  (no ELF interpreter). Agent sessions sandbox `~/.gradle` and wipe it on
  exit — recreate this file at the start of any session that builds.

`fdroid build` clones from GitHub at the pinned hash; to test an unpushed
commit, seed its clone first:
`cd build/dev.phylliida.memki && git fetch /path/to/local/repo main`.
Success ends with `compared built binary to supplied reference binary
successfully` + `allowed signer <fingerprint>`.

## 5. Pitfall log (what actually broke, in order)

1. **CI check `fdroid rewritemeta` failed** — our hand-written YAML had
   comments and non-canonical field order. Fix: run `fdroid rewritemeta`
   locally, commit the result.
2. **fdroid's pre-build `gradle clean` failed on a fresh clone** —
   `android/.gitignore` ignored `capacitor-cordova-android-plugins/`
   (cap-sync output), but Gradle reads its `cordova.variables.gradle` at
   *configuration* time, before any `npm ci`/`cap sync` can regenerate it.
   Fix: track those generated files (static with zero cordova plugins).
3. **Source scanner rejected `vendor/sqljs/sql-wasm.wasm`** (prebuilt
   binary). First fix was a `scanignore` entry, but reviewers asked for it
   gone — final fix: the wasm is no longer in git at all; npm `postinstall`
   (`scripts/copy-sqljs-wasm.js`) copies it from the lockfile-pinned sql.js
   package after the scan has already run.
4. **Tag pushes never triggered the release workflow** — both
   `on: push: tags:` and `on: create:` events from this repo's pushes don't
   reach Actions (only branch pushes do; likely the pushing credential type
   suppresses events). Fix: trigger the release workflow on `main` pushes
   and let it create the release+tag itself when `versionName` is new;
   `workflow_dispatch` remains as the manual fallback.
5. **Signing failed with a cryptic DER error** (`Tag number over 30 is not
   supported`) — the secrets were created in the `github-pages`
   *environment*, invisible to our job; the keystore decoded to an empty
   file. Fix: repository-level secrets. The workflow now prints
   `b64 chars / decoded bytes` and runs `keytool -list` before signing so
   the next failure names itself.
6. **`gh release create` glob error** — backslash line-continuations inside
   a YAML *plain* scalar get folded into spaces (`\ --title` reached the
   shell as an argument). Fix: use a block scalar (`run: |`) for multi-line
   commands.
7. **RB compare failed: zipalign markers** — the first signed APK contained
   `0xd935` extra fields that fdroid's build lacked. Cause: the workflow
   picked the runner's *newest* build-tools (35/36), whose apksigner
   realigns entries for 16KB page support while signing; apksigner 34.0.0
   (verified locally) doesn't. Fix: pin `apksigner` to
   `$ANDROID_HOME/build-tools/34.0.0` in the workflow.
8. **RB compare failed again: `classes.dex` + baseline profiles** — fdroid's
   buildserver builds with **OpenJDK 21** while GitHub CI used JDK 17, and
   D8/baseline-profile output differs across JDK majors. Fix: build the
   release with JDK 21. Verified: nix openjdk-21, Debian openjdk-21
   (buildserver), and temurin-21 (GitHub) all produce byte-identical APKs.

Diagnosis technique that mattered: download fdroid CI's **job artifacts**
(public even when job traces are 401) to get their unsigned APK, then
compare against ours entry-by-entry — content CRCs first (whose content
differs?), then zip structure (local-header extra fields). That split
"signing mutates the container" (#7) from "build inputs differ" (#8).

## 6. Release drill (from here on)

```bash
# 1. bump android/app/build.gradle: versionCode +1, versionName
# 2. add fastlane/metadata/android/en-US/changelogs/<versionCode>.txt
# 3. commit, tag, push:
git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
#    → release workflow auto-publishes the signed APK + release
# 4. fdroiddata fork: update versionName/versionCode/commit/CurrentVersion*,
#    fdroid rewritemeta + lint, commit, push branch → CI rebuilds + verifies
```

In fdroiddata, each release updates the single `Builds` entry in place
(new commit hash) plus `CurrentVersion`/`CurrentVersionCode`.

## 7. Useful links

- Inclusion policy: https://f-droid.org/en/docs/Inclusion_Policy/
- Build metadata reference: https://f-droid.org/en/docs/Build_Metadata_Reference/
- Reproducible builds: https://f-droid.org/docs/Reproducible_Builds
- fdroiddata repo: https://gitlab.com/fdroid/fdroiddata
- Our MR branch: `new-app-memki` on the fork
