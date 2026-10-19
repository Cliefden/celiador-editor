# Releasing the macOS app

How a `gulp vscode-darwin-arm64-min` build becomes something a stranger can
download from celiador.ai, open without a Gatekeeper prompt, and have auto-update.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `build/celiador/release-macos.sh` | this repo | Copies the built app, signs it inner-out with the Developer ID Application identity (hardened runtime, the entitlements under `build/azure-pipelines/darwin/`), notarizes through `asc`, staples, writes the update `.zip` and the `.dmg`, merges a `manifest.json` entry, and with `--publish` rsyncs it all to the box. |
| `.github/workflows/release-macos.yml` | this repo | The same, from a button: builds on the self-hosted Mac runner and runs the script. Manual only. |
| `GET /api/update/:platform/:quality/:commit` | daemon | The feed the built-in updater polls. `product.json` `updateUrl` is `https://celiador.ai`; `abstractUpdateService` appends the rest. 204 = up to date, otherwise the newest build's descriptor (Squirrel.Mac downloads its `url`). |
| `GET /api/releases[/latest/darwin-arm64/stable[/dmg]]`, `GET /api/releases/<file>` | daemon | The listing and the artifacts; what the site's download button and `/releases` page use. |
| `releases/manifest.json` | box, `~/daemon/releases` | `{ "releases": [ … ] }`, newest first. Appended, never pruned: only commits the manifest knows are ever offered an update, so a local dev build (unknown commit) is never "updated" to an older release. |

## One-time setup (Stefan)

1. **Developer ID Application certificate.** The account has none, and the App
   Store Connect API cannot create one — only the Account Holder can, at
   <https://developer.apple.com/account/resources/certificates/add>. Create the
   CSR in Keychain Access (Certificate Assistant → Request a Certificate From a
   Certificate Authority, saved to disk), upload it, download the `.cer`, double
   click to install. Check:

   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

   **The runner needs its own keychain.** The Actions runner is a launchd
   service started with `SessionCreate`, so it runs in a security session that
   does not see the login keychain at all: its first `codesign` fails with
   `errSecInternalComponent` whatever the key's ACL says. The identity therefore
   also lives in `~/Library/Keychains/celiador-signing.keychain-db`, a keychain
   with its own password that the workflow unlocks from the repository secret
   `CELIADOR_SIGNING_KEYCHAIN_PASSWORD`. To (re)create it from the key and
   certificate files:

   ```sh
   security create-keychain -p "<new password>" ~/Library/Keychains/celiador-signing.keychain-db
   security set-keychain-settings ~/Library/Keychains/celiador-signing.keychain-db   # never auto-lock
   security import developer-id.key -k ~/Library/Keychains/celiador-signing.keychain-db -P "" -T /usr/bin/codesign -T /usr/bin/security
   security import developerID_application.cer -k ~/Library/Keychains/celiador-signing.keychain-db
   security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "<new password>" ~/Library/Keychains/celiador-signing.keychain-db
   security list-keychains -d user -s ~/Library/Keychains/celiador-signing.keychain-db ~/Library/Keychains/login.keychain-db
   gh secret set CELIADOR_SIGNING_KEYCHAIN_PASSWORD --repo Cliefden/celiador --body "<new password>"
   ```

   Locally, `release-macos.sh` finds the identity through the search list; pass
   `--keychain` (or `CELIADOR_SIGNING_KEYCHAIN`) to pin it the way the workflow does.

   Keep a backup of the key and certificate somewhere safe: Developer ID
   certificates cannot be re-downloaded with their key, and only five may exist.
   (If the certificate was made from an `openssl` CSR, the `.key` + `.cer` files
   are that backup.)

2. **Notarization credentials.** Already there: `asc` is signed in with the
   App Store Connect API key (`asc auth status`), which the Notary API accepts.

3. **The box.** Nothing to install: the daemon serves the feed from
   `~/daemon/releases`, which the script creates on first publish. Deploy the
   daemon version with `src/releases/` first (see the daemon README's deploy
   notes), then confirm `curl -i https://celiador.ai/api/releases` returns
   `{"releases":[]}` rather than a 404.

## Cutting a release

Locally (same Mac as the runner):

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  fnm exec --using 24.18.0 npm run gulp vscode-darwin-arm64-min
build/celiador/release-macos.sh --notes "Fixes the phone transcript." --publish
```

Or Actions → *Release (macOS)* → *Run workflow*, with the notes. Either way the
build is identified by its commit (`product.json` `commit`), so release from a
clean, pushed `main`.

Afterwards:

```sh
curl -s https://celiador.ai/api/releases/latest/darwin-arm64/stable | jq .
curl -sI https://celiador.ai/api/update/darwin-arm64/stable/<previous commit>   # 200 → offered
curl -sI https://celiador.ai/api/update/darwin-arm64/stable/<this commit>       # 204 → up to date
```

## Verifying on a clean Mac

The first-outside-tester check (editor#21): on a fresh macOS user account,
download the DMG from celiador.ai, drag to Applications, open. Expect no
Gatekeeper dialog beyond the standard "downloaded from the internet" one, and the
"Celiador Safe Storage" keychain prompt exactly once. Then, from an earlier
published build, *Celiador → Check for Updates…* should download and offer a
restart.

## Local checks without notarizing

`--skip-notarize --identity "Apple Development: Stefan Crafoord-Wiklund (4XPCJFA6J4)"`
exercises everything but Apple: the inner-out signing order, the entitlements,
the packaging and the manifest merge. The result runs on this Mac but Gatekeeper
rejects it elsewhere, and `--publish` refuses it.

## The bundled extension is compiled by the build

`celiador-ai` is a plain tsc extension; the packaging stream copies its `out/`
rather than building it. The platform build task therefore runs
`compile-extension:celiador-ai` first (a Celiador change in `build/gulpfile.vscode.ts`),
so a clean checkout ships the extension and a local build never ships a stale
`out/`. The release script refuses an app whose packaged extension is missing or
older than `extensions/celiador-ai/src`, and the workflow has the same check.

## Why not `codesign --deep`

`--deep` is deprecated and applies the outer entitlements to every nested
helper; notarization rejects the result (the renderer helper must not carry the
app's camera/microphone entitlements, the plugin helper needs
`disable-library-validation` for native modules). The script signs each helper
with its own plist, the way VS Code's own pipeline does.

## Linux

Same feed, same manifest, no signing (v1). The pieces:

| Piece | Where | What it does |
|---|---|---|
| `build/celiador/release-linux.sh` | this repo | Takes the CI's `Celiador-linux-x64-<version>.{tar.gz,deb,rpm}`, reads `product.json` out of the tarball (commit, build number, extension present), renames the files to carry the commit, hashes them, merges a `linux-x64` manifest entry (`archive` = tar.gz, `.deb`/`.rpm` under `assets`) and with `--publish` rsyncs files first, manifest last. |
| `.github/workflows/release-linux.yml` | this repo | Manual. Job 1 builds on a hosted Ubuntu runner (the glibc 2.28 sysroot setup is Linux-only) and hands the packages over as a 1-day artifact; job 2 runs the script on the self-hosted Mac, the machine with ssh to the box. |
| `GET /api/releases/latest/linux-x64/stable/{deb,rpm,archive}` | daemon | Stable download links. `kind` is now any asset the entry carries, on every platform. |
| `GET /api/update/linux-x64/stable/<commit>` | daemon | What an installed Linux Celiador polls. There is no in-place updater on Linux, so the descriptor's `url` is the **download page**, not an archive: the editor shows "update available" and opens it in the browser. |

Cutting a Linux release: Actions → *Release (Linux)* → *Run workflow*, with notes.
Afterwards `curl -s https://celiador.ai/api/releases/latest/linux-x64/stable | jq .`
should show the build with `assetUrls.deb` and `assetUrls.rpm`, and the download
page's Linux row lists the three links.

Checking a package without a Linux box: `docker run --rm -it -v "$PWD/.build/out:/pkg" ubuntu:24.04`
then `apt-get update && apt-get install -y /pkg/Celiador-linux-x64-*.deb && celiador --version`
(the CLI prints the version without needing a display).

Follow-ups: arm64 in the matrix; `.deb`/`.rpm` GPG signing so apt/dnf repos
become possible; snap/flatpak only if testers ask.
