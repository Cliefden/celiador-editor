# Build channels — dev / staging / prod

The editor ships in three channels that point at the matching daemon environment
(see `daemon/ENVIRONMENTS.md`). Each channel is a distinct app identity so all
three install side-by-side without clobbering each other's profile/keychain.

The `celiador-ai` extension resolves the daemon URL as: `celiador.daemonUrl`
setting (user override) → `celiadorDaemonUrl` in `product.json` (build default)
→ `https://celiador.ai`. So a channel is defined purely by its `product.json`.

| Channel | `nameShort`/`nameLong` | `applicationName` | `dataFolderName` | `darwinBundleIdentifier` | `urlProtocol` | `celiadorDaemonUrl` |
|---|---|---|---|---|---|---|
| **prod** | Celiador | celiador | .celiador | ai.celiador.editor | celiador | `https://celiador.ai` |
| **staging** | Celiador Staging | celiador-staging | .celiador-staging | ai.celiador.editor.staging | celiador-staging | `https://staging.celiador.ai` |
| **dev** | Celiador Dev | celiador-dev | .celiador-dev | ai.celiador.editor.dev | celiador-dev | `http://localhost:4661` |

`product.json` in the repo carries the **prod** values. To cut a staging/dev
build, override those fields before running the gulp build (e.g. a
`product.staging.json` merged over `product.json`, or a scripted `jq`/sed pass in
the build step), then build as usual:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  fnm exec --using 24.18.0 npm run gulp vscode-darwin-arm64-min
```

Note: the deep-link `AUTH_REDIRECT` in `extensions/celiador-ai/src/auth.ts`
(`celiador://celiador.celiador-ai/auth-callback`) is tied to `urlProtocol`. If a
channel changes `urlProtocol`, that channel's GoTrue redirect allowlist must
include the corresponding `celiador-staging://…` / `celiador-dev://…` URI.

Individual developers don't need a separate build — set
`"celiador.daemonUrl": "http://localhost:4661"` in settings to point the prod
build at a local daemon.
