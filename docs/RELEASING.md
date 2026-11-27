# Releasing the macOS app

How a `gulp vscode-darwin-arm64-min` build becomes something a stranger can
download from celiador.ai, open without a Gatekeeper prompt, and have auto-update.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `build/celiador/release-macos.sh` | this repo | Copies the built app, signs it inner-out with the Developer ID Application identity (hardened runtime, the entitlements under `build/azure-pipelines/darwin/`), notarizes through `asc`, staples, writes the update `.zip` and the `.dmg`, merges a `manifest.json` entry, and with `--publish` rsyncs it all to the box. |
| `.github/workflows/release-macos.yml` | this repo | The same, from a button: builds on the self-hosted Mac runner and runs the script. Manual for any channel (prod is manual only); also a test build on every `Cliefden/celiador` train tag and a nightly dev build (see [Channels](#channels)). |
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
   gh secret set CELIADOR_SIGNING_KEYCHAIN_PASSWORD --repo Cliefden/celiador-editor --body "<new password>"
   ```

   Locally, `release-macos.sh` finds the identity through the search list; pass
   `--keychain` (or `CELIADOR_SIGNING_KEYCHAIN`) to pin it the way the workflow does.

   Keep a backup of the key and certificate somewhere safe: Developer ID
   certificates cannot be re-downloaded with their key, and only five may exist.
   (If the certificate was made from an `openssl` CSR, the `.key` + `.cer` files
   are that backup.)

2. **Notarization credentials.** Notarization goes through an App Store Connect
   API key, which the Notary API accepts. Locally, `asc` is signed in with it
   (`asc auth status`). The runner's session can't read the keychain profile
   `asc` stores, so the workflow hands `asc` the key explicitly:

   - the key file at `~/.appstoreconnect/private_keys/AuthKey_<key ID>.p8` on
     the runner Mac;
   - the key ID in the repository secret `CELIADOR_ASC_KEY_ID`;
   - the issuer ID in the repository secret `CELIADOR_ASC_ISSUER_ID`.

   The workflow's first step fails with a clear error when either secret or
   the key file is missing. The key ID never goes in the YAML: rotating the key
   only touches the secrets and the key file.

   ```sh
   gh secret set CELIADOR_ASC_KEY_ID --repo Cliefden/celiador-editor --body "<key ID>"
   gh secret set CELIADOR_ASC_ISSUER_ID --repo Cliefden/celiador-editor --body "<issuer ID>"
   ```

   **Rotating the key.** In App Store Connect → Users and Access → Integrations
   → App Store Connect API, create a new key (role Developer is enough for
   notarization) and download its `.p8` (it can be downloaded only once). Put it
   at `~/.appstoreconnect/private_keys/AuthKey_<new key ID>.p8` on the runner
   (`chmod 600`), update `CELIADOR_ASC_KEY_ID` (and `CELIADOR_ASC_ISSUER_ID` if
   it changed), point the local `asc` profile at the new key (check with `asc auth status`), cut a dev
   build to confirm notarization, then revoke the old key and delete its `.p8`.

3. **The box.** Nothing to install: the daemon serves the feed from
   `~/daemon/releases`, which the script creates on first publish. Deploy the
   daemon version with `src/releases/` first (see the daemon README's deploy
   notes), then confirm `curl -i https://celiador.ai/api/releases` returns
   `{"releases":[]}` rather than a 404.

## Cutting a release

Locally (same Mac as the runner):

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  fnm exec --using 24.22.1 corepack pnpm run gulp vscode-darwin-arm64-min
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

Before testing the release on this Mac, make sure `/Applications` actually runs it. The release run ends with this check; run it alone with:

```sh
build/celiador/release-macos.sh --check-installed   # exit 0: installed app is this commit (or newer)
```

It also fails when the installed bundle is not writable by you (for example root-owned after a `sudo` copy): the built-in updater cannot replace such a bundle, so later releases would silently never arrive.

## Rolling back a release

How the feed decides (daemon `src/releases/`): for each platform and quality it offers the entry with the newest `timestamp` (the build date in the app's `product.json`) to every installed app whose commit the manifest lists and is not that newest one. An app whose commit the manifest does not list is told it is up to date (204), and the updater never downgrades by itself. So a bad release is undone by changing which entry is newest. The daemon itself needs nothing: an editor release only changes the app.

### 1. Demote the bad build (minutes)

On the box, give the bad entry an older timestamp than the last good one, in the channel's manifest (`~/daemon/releases` for prod, `~/envs/<test|dev>/daemon/releases` otherwise):

```sh
ssh cliefden.com
cd ~/daemon/releases
cp manifest.json "manifest.json.bak-$(date +%Y%m%d-%H%M)"
BAD=<bad commit> GOOD=<last good commit> node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const pick = c => m.releases.find(r => r.platform === "darwin-arm64" && r.version.startsWith(c));
  const bad = pick(process.env.BAD), good = pick(process.env.GOOD);
  if (!bad || !good) { throw new Error("commit not in the manifest"); }
  bad.timestamp = good.timestamp - 1000;
  m.releases.sort((a, b) => b.timestamp - a.timestamp);
  fs.writeFileSync("manifest.json.new", JSON.stringify(m, null, 2) + "\n");
'
mv manifest.json.new manifest.json   # atomic: the daemon re-reads on change, and an unreadable manifest empties the feed
```

Then the last good build is the newest again: apps that have not updated are no longer offered the bad one, the download button serves the good DMG, and apps already on the bad build are offered the good one. Check:

```sh
curl -s https://celiador.ai/api/releases/latest/darwin-arm64/stable | jq .version   # the good commit
curl -sI https://celiador.ai/api/update/darwin-arm64/stable/<bad commit>           # 200: offered the good build
curl -sI https://celiador.ai/api/update/darwin-arm64/stable/<good commit>          # 204
```

Undo by moving the backup back. Later releases keep the edit: the release script merges into the published manifest.

Demote, don't delete. A deleted entry makes the bad build's commit unknown, so apps already on it are told they are up to date, and they never get any later release either; only reinstalling from the DMG reaches them.

Going back is a downgrade: those apps move to the older VS Code base, and the updater installs a lower build number. Neither has been tried yet; rehearse it on the dev channel before you need it.

### 2. Ship the fix

Usually, fix it on `main` and cut a new prod release; everyone updates normally.

When there is no quick fix, release the last good code as a new build: branch from the last good commit, add one empty commit (`git commit --allow-empty -m "Release <last good> again"`), push, and run *Release (macOS)* from that branch with channel prod. It is newer than everything in the manifest, so it reaches everyone, including apps stranded on a deleted entry's commit, which can still install the DMG by hand. The empty commit matters: rebuilding a commit the manifest already lists replaces its entry and overwrites its files under the same names, which the daemon serves as immutable and caches keep.

Don't revert an upstream sync merge on `main` to roll back: a revert of a merge that size makes the next sync painful. Fix forward, or release from a branch as above.

### Linux

`release-linux.sh` writes into the same manifest. Treat `linux-x64` entries the same way (change the `platform` in the script above).

## Channels

The same pipeline cuts the test and dev channels (`CHANNELS.md`): run
`build/celiador/channel.sh test` (or `dev`) before the gulp build, and the
release script reads the channel from the packaged app's `product.json` and
publishes to that environment's daemon (`~/envs/test/daemon/releases`,
`https://test.celiador.ai/api/releases`) under quality `insider`. Each
environment's update feed therefore only ever offers its own channel's builds.
From Actions, pick the channel in *Release (macOS)* → *Run workflow*. Restore
prod (`channel.sh prod`) before committing anything — the committed
`product.json` is always prod.

Test and dev also build on their own; both build this repo's `main`:

| Channel | Trigger | Icon label | Skipped when |
|---|---|---|---|
| test | a `vX.Y.Z` tag pushed in `Cliefden/celiador` (`scripts/release.sh`): that repo's `editor-test-build.yml` sends a `repository_dispatch` (`celiador-release`, payload `{"tag":"vX.Y.Z"}`) here | the train tag | — |
| dev | nightly, 03:17 UTC (`schedule`) | the short commit | the dev feed already lists this commit for `darwin-arm64`/`insider` |

The first job (*Plan*, a hosted runner) turns the trigger into channel, notes
and label, so a nightly with nothing new never wakes the Mac. Both need the
self-hosted runner awake; a missed night is simply skipped. The dispatch needs
one secret in `Cliefden/celiador`: `EDITOR_DISPATCH_TOKEN`, a fine-grained
token for `Cliefden/celiador-editor` only with *Contents: read and write*
(that is what `POST /repos/…/dispatches` requires):

```sh
gh secret set EDITOR_DISPATCH_TOKEN --repo Cliefden/celiador --body "<token>"
```

Without it the tag still deploys daemon + web + iOS; the editor step warns and
the test build can be started by hand. To start one by hand exactly as a tag would:

```sh
gh api repos/Cliefden/celiador-editor/dispatches -f event_type=celiador-release -f 'client_payload[tag]=v0.2.3'
```

`celiador-build.yml` (unsigned multi-platform packages) no longer runs on tag
pushes; it's manual only.

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
