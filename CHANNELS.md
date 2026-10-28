# Build channels — dev / test / prod

The editor ships in three channels that point at the matching daemon environment
(`daemon/ENVIRONMENTS.md`). Each channel is a distinct app identity, so all three
install side by side without clobbering each other's profile, keychain item or
update feed.

A channel is defined purely by `product.json`. The committed file is **prod**;
`build/celiador/channel.sh <dev|test|prod>` overlays `build/celiador/product.<channel>.json`
(or restores prod) before the gulp build:

```sh
build/celiador/channel.sh test
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  fnm exec --using 24.18.0 npm run gulp vscode-darwin-arm64-min
build/celiador/channel.sh prod        # restore before committing anything
```

| Channel | `nameLong` | `applicationName` | `dataFolderName` | `darwinBundleIdentifier` | `urlProtocol` | `celiadorDaemonUrl` = `updateUrl` | `quality` | Built |
|---|---|---|---|---|---|---|---|---|
| **prod** | Celiador | celiador | .celiador | ai.celiador.editor | celiador | `https://celiador.ai` | stable | manual *Release (macOS)* |
| **test** | Celiador Test | celiador-test | .celiador-test | ai.celiador.editor.test | celiador-test | `https://test.celiador.ai` | insider | on a daemon release tag, or manual |
| **dev** | Celiador Dev | celiador-dev | .celiador-dev | ai.celiador.editor.dev | celiador-dev | `https://dev.celiador.ai` | insider | nightly from `main`, or manual |

`celiadorDaemonUrl` is read in three places, so one value switches the whole client:
- the `celiador-ai` extension (`resolveDaemonUrl()` — the `celiador.daemonUrl` setting
  overrides it per user without a rebuild),
- the native agent host (`src/vs/platform/agentHost/node/claude/claudeAgent.ts`),
- the agent-session relay bridge
  (`src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/celiadorRelayBridge.ts`).
All three fall back to `https://celiador.ai` when the field is unset.

`updateUrl` is what the built-in updater polls (`/api/update/:platform/:quality/:commit`),
so a dev build only ever sees dev builds and a test build only test builds: the
release script reads `celiadorChannel` from the packaged app's `product.json` and
publishes to that environment's daemon (`~/envs/<env>/daemon/releases`), under the
channel's `quality`.

The extension's auth deep link follows `urlProtocol`
(`<urlProtocol>://celiador.celiador-ai/auth-callback`, `productConfig.ts`), so each
channel returns to its own app. Each environment's GoTrue allowlist holds its
channel's scheme: `celiador-dev://*` on dev, `celiador-test://*` (and the iOS test
app's `celiador://*`) on test, `celiador://*` on prod.

Individual developers don't need a separate build — set
`"celiador.daemonUrl": "http://localhost:4661"` in settings to point any channel at a
local daemon.
