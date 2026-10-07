# Celiador AI

Celiador's identity + companion shell for the editor. The agent itself is the
native agentHost Claude provider (routed through the daemon, see
`src/vs/platform/agentHost/node/claude/`), and session relay to the phone lives in
core (`src/vs/workbench/contrib/agentSessions/agentHost/celiadorRelay*.ts`). This
extension provides what sits around it:

- **`celiador` authentication provider** — Supabase sign-in (PKCE) whose token the
  agent host uses to call the daemon.
- **Celiador sidebar** — a Welcome view (sign-in call to action / account greeting)
  and a **Changes** git-review view.
- Commands: `Celiador: Sign In`, `Sign Out`, `Account`, `Past Chats`,
  `Manage Billing`, `Check Daemon Connection`.

## Settings

Both are restricted (ignored from workspace settings in untrusted workspaces):

- `celiador.daemonUrl` — daemon base URL. Empty uses the build channel's
  `celiadorDaemonUrl` from `product.json` (prod `https://celiador.ai`).
- `celiador.supabaseUrl` — sign-in URL override. Empty uses the daemon's
  `GET /api/config`.

## Build & test

Built and bundled with the editor (`npm run gulp compile-extensions`). Standalone:

```bash
npm install
npm run test:unit
```
