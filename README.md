# Celiador

Celiador is an AI code editor — a **direct hard fork of [Visual Studio Code](https://github.com/microsoft/vscode)** (the `Code - OSS` source), with an AI agent (`celiador-ai`) built in. Think of the relationship to VS Code the way Cursor relates to it: we fork the source and edit it directly, rather than layering an extension on top of a stock install.

- **Base:** `microsoft/vscode` — tracked via the `upstream` git remote (see [Staying current](#staying-current)).
- **Backend:** the AI layer talks to the Celiador daemon (`celiador.ai`), which lives in the separate [`celiador-daemon`](https://github.com/Cliefden/celiador-daemon) repo. Sign-in is unified Supabase auth; the daemon holds the shared LLM key.
- **Extensions marketplace:** [Open VSX](https://open-vsx.org) (not the Microsoft Marketplace).

> This repo *is* the editor. The previous VSCodium build-orchestrator approach (`celiador-editor`) is retired to reference-only — a hard fork lets us edit editor core directly instead of maintaining a patch stack.

## Requirements (macOS, Apple Silicon)

| Tool | Version / note |
|------|----------------|
| Node | **24.18.0** (matches vscode's `.nvmrc`) — via [`fnm`](https://github.com/Schniz/fnm): `fnm exec --using 24.18.0 <cmd>` |
| Xcode | `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` is **required** for native-module (`node-gyp`) builds |
| jq | any recent version |

## Build

```sh
# 1. install dependencies (native modules build here — hence DEVELOPER_DIR)
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  fnm exec --using 24.18.0 npm install

# 2. package the desktop app
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  fnm exec --using 24.18.0 npm run gulp vscode-darwin-arm64-min
```

The packaged app is written **one level up** from this repo (vscode's `buildRoot` is the parent dir):

```
../VSCode-darwin-arm64/Celiador.app
```

### Sign it (local runs)

The build does not code-sign. Sign with a **stable named identity** — never ad-hoc (`codesign -s -`), or macOS re-prompts for the "Celiador Safe Storage" keychain item on every launch:

```sh
codesign --force --deep --sign "Apple Development: <your identity>" \
  ../VSCode-darwin-arm64/Celiador.app
```

On first launch, approve the "Celiador Safe Storage" keychain prompt once ("Always Allow"); it then persists across rebuilds.

## CI builds (macOS, Windows, Linux)

[`.github/workflows/celiador-build.yml`](.github/workflows/celiador-build.yml) builds all three platforms on every push to `main`, on pull requests that touch the build, packaging or branding, and on demand (Actions → Celiador Build → Run workflow). Packages are uploaded as workflow artifacts:

| Platform | Runner | Output |
|----------|--------|--------|
| macOS arm64 | `macos-15` | `.dmg`, `.zip` |
| Windows x64 | `windows-2022` | user installer, system installer, `.zip` |
| Linux x64 | `ubuntu-24.04` | `.deb`, `.rpm`, `.tar.gz` |

Pushing a `v*` tag (e.g. `v0.1.0`) also attaches everything to a **draft** GitHub release.

macOS signing: add the repository secrets `MACOS_CERTIFICATE` (base64 of a `.p12` export), `MACOS_CERTIFICATE_PASSWORD` and `MACOS_SIGNING_IDENTITY` to sign with your named identity. Without them the app is signed ad-hoc, and downloaded copies need `xattr -dr com.apple.quarantine Celiador.app` before first launch. Windows builds are unsigned, so SmartScreen warns on install.

## Layout

- `extensions/celiador-ai/` — the built-in AI extension (chat + agent, wired to the daemon). A normal source extension; the vscode build packages its compiled `out/`.
- `product.json` — Celiador branding (`ai.celiador.editor`, `celiador://` URL protocol, `.celiador` data dir), Open VSX gallery config.
- `resources/darwin/code.icns` — the Celiador app icon.

## Customizations vs upstream

Kept intentionally small so upstream merges stay cheap. Beyond branding + the bundled extension:

- **Open VSX** as the extension gallery, with signature verification relaxed so Open VSX extensions install.
- **Issue reporter** points at this repo instead of `microsoft/vscode`.
- **Onboarding walkthrough** disabled.

Deferred (larger, done as focused follow-ups): removing the built-in Copilot subsystem, custom UI font, stripping residual Microsoft branding strings.

## Staying current

`upstream` points at `microsoft/vscode`. To pull a newer release:

```sh
git fetch upstream --tags
git merge <tag>        # e.g. 1.139.0
```

Keep core edits minimal and localized so these merges stay low-conflict.

## License

MIT — see [`LICENSE.txt`](LICENSE.txt). Celiador is an independent fork and is not affiliated with or endorsed by Microsoft.
