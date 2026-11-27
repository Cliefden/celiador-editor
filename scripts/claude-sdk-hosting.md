# Hosting the Claude Agent SDK for built Celiador editors

A **built** Celiador editor does not bundle `@anthropic-ai/claude-agent-sdk`. The
agent host registers the Claude agent only when `product.agentSdks.claude` is set,
and then **downloads** the SDK on first use from that config's `urlTemplate`
(`src/vs/platform/agentHost/node/agentSdkDownloader.ts`). So a shipped build needs
the per-platform SDK tarballs hosted. (Source/dev runs, `isBuilt === false`, skip
all of this — the provider registers and the SDK loads from `node_modules`, or from
`CELIADOR_AGENT_HOST_CLAUDE_SDK_ROOT` if set.)

## The contract

`product.json` (already committed):

```json
"agentSdks": {
  "claude": {
    "version": "0.3.304",
    "urlTemplate": "https://celiador.ai/sdk/claude/0.3.304/{sdkTarget}.tgz"
  }
}
```

The downloader substitutes `{sdkTarget}` (one of `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `win32-x64`,
`win32-arm64`), downloads the `.tgz`, extracts it, and imports
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` from the extracted root.

## 1. Build the tarballs

Preferred: upstream's packager, which installs from the pinned lockfile in
`build/agent-sdk/agents/claude/`, omits the SDK's peer dependencies and checks the
result loads (see `build/agent-sdk/README.md`):

```sh
node build/agent-sdk/package.ts --sdk=claude --target=darwin-arm64 --out=.build/claude-sdk
node build/agent-sdk/package.ts --sdk=claude --target=darwin-x64 --out=.build/claude-sdk
```

It writes `claude-<version>-<sdkTarget>.tgz`; host it as `<version>/<sdkTarget>.tgz`.

The older script still works, but it resolves the SDK from the registry rather than
the lockfile:

```sh
scripts/build-claude-sdk-tarballs.sh            # version read from node_modules
# or: scripts/build-claude-sdk-tarballs.sh 0.3.304
```

Output: `.build/claude-sdk/0.3.304/<sdkTarget>.tgz` — the path mirrors the URL, so
hosting is a plain sync. Each tarball contains the main SDK **and** the matching
native package (`@anthropic-ai/claude-agent-sdk-<sdkTarget>`), selected via npm
`--os/--cpu/--libc`, so one host (e.g. a mac) builds every platform's artifact.

## 2. Host them (pick one)

So that `https://celiador.ai/sdk/claude/0.3.304/<sdkTarget>.tgz` resolves:

- **Caddy static dir (simplest on the box).** Put the files under e.g.
  `/var/www/celiador/sdk/claude/0.3.304/` and add to the Caddyfile:

  ```
  handle_path /sdk/* {
      root * /var/www/celiador/sdk
      file_server
  }
  ```

- **celiador-web (`public/`).** Drop `public/sdk/claude/0.3.304/*.tgz` into the
  Next.js app; they're served at `/sdk/...` on the same origin.

- **A CDN / object store.** Upload and point `urlTemplate` at that origin instead.

No auth is required (the SDK is public), but the files are large — **~100 MB per
target** (the native package bundles the full `claude` CLI), ~800 MB across all
eight. Prefer a CDN / static file server over the daemon process, and keep only the
targets you actually ship if space is tight (at minimum `darwin-arm64` + `darwin-x64`
for the macOS build).

## 3. Bumping the SDK version

1. Bump the SDK pin as `build/agent-sdk/README.md` § "Bumping an SDK version" describes
   (the `agents/claude` pin + lockfile and the root `package.json` devDependency move
   together; an upstream sync usually does this for you).
2. Update BOTH the `version` and the `{version}` in `urlTemplate` in `product.json`
   (only `{sdkTarget}` is substituted; the version is literal in the path).
3. Build the tarballs and host the new `<version>/` directory **before** a release
   ships the new `product.json` — a released app pointing at a missing version can't
   start the Claude agent. Old versions stay hosted so already-cached clients and
   rollbacks keep working.

Because the bump in step 1 arrives with upstream syncs while `product.json` does not,
the two drift apart (the 2026-11 syncs moved the pin to 0.3.304 while `product.json`
still downloaded 0.3.258). Check `product.json` after every sync.

## Verifying

On a built app, first use of the Agents Window triggers the download; check the
agent-host log for `[AgentSdkDownloader] claude: downloading from …` then
`cache hit`. A 404 there means the tarball isn't hosted at the expected path; a
module-load error means the tarball layout is wrong (it must contain
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` at its root).
