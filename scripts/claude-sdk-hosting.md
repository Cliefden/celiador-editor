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
    "version": "0.3.258",
    "urlTemplate": "https://celiador.ai/sdk/claude/0.3.258/{sdkTarget}.tgz"
  }
}
```

The downloader substitutes `{sdkTarget}` (one of `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `win32-x64`,
`win32-arm64`), downloads the `.tgz`, extracts it, and imports
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` from the extracted root.

## 1. Build the tarballs

```sh
scripts/build-claude-sdk-tarballs.sh            # version read from node_modules
# or: scripts/build-claude-sdk-tarballs.sh 0.3.258
```

Output: `.build/claude-sdk/0.3.258/<sdkTarget>.tgz` — the path mirrors the URL, so
hosting is a plain sync. Each tarball contains the main SDK **and** the matching
native package (`@anthropic-ai/claude-agent-sdk-<sdkTarget>`), selected via npm
`--os/--cpu/--libc`, so one host (e.g. a mac) builds every platform's artifact.

## 2. Host them (pick one)

So that `https://celiador.ai/sdk/claude/0.3.258/<sdkTarget>.tgz` resolves:

- **Caddy static dir (simplest on the box).** Put the files under e.g.
  `/var/www/celiador/sdk/claude/0.3.258/` and add to the Caddyfile:

  ```
  handle_path /sdk/* {
      root * /var/www/celiador/sdk
      file_server
  }
  ```

- **celiador-web (`public/`).** Drop `public/sdk/claude/0.3.258/*.tgz` into the
  Next.js app; they're served at `/sdk/...` on the same origin.

- **A CDN / object store.** Upload and point `urlTemplate` at that origin instead.

No auth is required (the SDK is public), but the files are large — **~100 MB per
target** (the native package bundles the full `claude` CLI), ~800 MB across all
eight. Prefer a CDN / static file server over the daemon process, and keep only the
targets you actually ship if space is tight (at minimum `darwin-arm64` + `darwin-x64`
for the macOS build).

## 3. Bumping the SDK version

1. Update `@anthropic-ai/claude-agent-sdk` in the editor `package.json` + reinstall.
2. Update BOTH the `version` and the `{version}` in `urlTemplate` in `product.json`
   (only `{sdkTarget}` is substituted; the version is literal in the path).
3. Re-run the build script and host the new `<version>/` directory. Old versions can
   stay hosted so already-cached clients and rollbacks keep working.

## Verifying

On a built app, first use of the Agents Window triggers the download; check the
agent-host log for `[AgentSdkDownloader] claude: downloading from …` then
`cache hit`. A 404 there means the tarball isn't hosted at the expected path; a
module-load error means the tarball layout is wrong (it must contain
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` at its root).
