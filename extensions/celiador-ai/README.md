# Celiador AI

The AI layer for the Celiador editor (a VS Code fork). Milestone 1 scaffold: a
sidebar chat view + commands that round-trip to the **Celiador daemon**
(`celiador.ai` by default), proving the editor ↔ backend wiring.

## What it does today (M1)

- Adds a **Celiador** activity-bar view with a chat panel.
- `Celiador: Open Chat` — focus the chat panel.
- `Celiador: Check Daemon Connection` — probes `GET /api/health` (+ `/api/config`)
  and reports status/auth mode.
- A status-bar item (`✨ Celiador`) that opens the chat.

Each chat turn currently calls the daemon and confirms connectivity. The real
agent endpoint (streaming code edits as reviewable proposals) slots into
`probeDaemon()`'s call site in `src/extension.ts`.

## Settings

- `celiador.daemonUrl` (default `https://celiador.ai`) — daemon base URL.
- `celiador.token` — optional bearer token for authenticated daemons.

## Build

```bash
npm install
npm run compile
```

## Bundling into the editor (later milestone)

For M1 this is developed/installed as a VSIX. To ship it as a **built-in**
extension, copy the compiled extension into `vscode/extensions/celiador-ai/`
before the gulp build (via the orchestrator overlay or a patch) so it is
packaged into `Celiador.app`.
