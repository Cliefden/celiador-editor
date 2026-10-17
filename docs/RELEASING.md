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

   Then open Keychain Access → the private key → Access Control → "Allow all
   applications" (or add `codesign`), so the runner's launchd service can sign
   without a UI prompt. Export a `.p12` backup somewhere safe: Developer ID
   certificates cannot be re-downloaded with their key, and only five may exist.

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
