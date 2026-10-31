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

The dev and test channels also get Celindor's icon banner: `channel.sh` stamps
`resources/darwin/code.icns` (through an `iconutil` round-trip and
`build/celiador/icon-banner.swift`, no ImageMagick needed) red with the short
commit for dev, green with the tag at `HEAD` (else the commit) for test; an
optional second argument sets the label (`channel.sh test v0.2.0`). The
committed icon is always prod; `channel.sh prod` restores it.

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
local daemon. Note that the setting redirects only the extension (sign-in, account,
chats); the native agent host, relay bridge and presence keep the build's
`celiadorDaemonUrl`.

## Seeing where you are

The first status bar item (`extensions/celiador-ai/src/environmentStatus.ts`) names the environment this window works against: `prod` plain, `TEST` / `DEV` / `LOCAL` on the amber warning background, and the red error background when the client is split — the `celiador.daemonUrl` setting points the extension somewhere other than the build's daemon, the daemon reports a different `env` than its host name implies, or a build's channel and its daemon URL disagree. The environment comes from the daemon's own `GET /api/health` (`env`, `version`, `commit`); until it answers, the host name stands in. The tooltip lists build (name, version, build number, commit, channel) and daemon; the item's quick pick (also **Celiador: Show Environment**) copies that as one line for an issue, opens the daemon, or opens the setting. `describeEnvironment()` in `environment.ts` is pure and covered by `src/test/unit/environment.test.ts`.

The channel builds also carry their name in the title bar (`nameLong`: "Celiador Dev", "Celiador Test") and the banner on the dock icon; the status item is what still tells the truth after a `celiador.daemonUrl` override.
