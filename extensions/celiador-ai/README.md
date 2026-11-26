# Celiador AI

Celiador's identity and companion shell for the editor. The agent itself is the native agent host Claude provider, routed through the daemon (`src/vs/platform/agentHost/node/claude/`). The phone relay lives in core under `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/`:

- `celiadorRelayBridge.ts` and `celiadorRelayClient.ts` mirror agent sessions to the daemon's relay and take the phone's commands back.
- `celiadorEditorControl.ts` handles the phone's "Run on your editor" requests and agent tasks.
- `celiadorWorkspacePresence.ts` reports the open repositories.

This extension provides what sits around them:

- **`celiador` authentication provider.** Supabase sign-in (password, magic link or GitHub, with PKCE). The agent host and the relay use its token to call the daemon.
- **Agents view** (activity bar → Agents). The daemon's task queue, grouped like the phone shows it: Needs you, Ready to merge, Running, Merged today. **Run an Issue…** queues a GitHub issue from an open repository. Each task opens a run panel in the editor with the transcript, the diff, merge and send back.
- **Agent tasks.** When the editor runs a queued issue in its own worktree, this extension commits, pushes and opens the pull request (`celiador.finishTask`). It also posts the "picked up" comment on the issue.
- **Run review over the relay.** `celiador.relayGit` runs the phone's git status, diff, commit, revert, push, PR and merge requests through the editor's git extension.
- **Chat sidebar views.** **Account** (sign-in call to action, or plan and usage) and **Changes** (the workspace's git changes; click a file for its diff).
- **Tab autocomplete** (experimental, off by default). Inline completions through the daemon. Turn it on with `Celiador: Toggle Tab Autocomplete`.
- **Status bar.** The environment the window works against (amber off prod), the signed-in account, and the remaining balance.
- **Commands:** `Celiador: Sign In`, `Sign Out`, `Account`, `Past Chats`, `Manage Billing`, `Delete Account`, `Check Daemon Connection`, `Show Environment`, `Toggle Tab Autocomplete`, and `Run an Issue…` in the Agents view.

## Settings

- `celiador.daemonUrl`: the daemon base URL. Leave it empty to use the build channel's `celiadorDaemonUrl` from `product.json` (prod `https://celiador.ai`). The relay, presence and editor control in core use the same value. Restricted and application-scoped, so a workspace can't change it.
- `celiador.supabaseUrl`: the sign-in URL. Leave it empty to use the daemon's `GET /api/config`. Restricted and application-scoped.
- `celiador.inlineCompletions.enabled`, `celiador.inlineCompletions.debounceMs`: Tab autocomplete.

The agent-task settings (`celiador.agentTasks.*`) are registered by core in `celiadorEditorControl.ts`.

## Build and test

The editor builds and bundles this extension (`pnpm run gulp compile-extensions`). It is a member of the root pnpm workspace, so the root `pnpm install` installs its dependencies. Unit tests run with Node's test runner and need no editor:

```bash
cd extensions/celiador-ai
pnpm run test:unit
```

## The daemon's API types

The daemon's wire types (profile, chats, `/api/me`, tasks, session events, health, config) come from its OpenAPI spec in `Cliefden/celiador` (`packages/client`). `src/contract/schema.ts` is a vendored copy pinned to the celiador commit in `src/contract/SOURCE`. Never edit it by hand: `pnpm run sync-contract` re-vendors from celiador `main` (or `pnpm run sync-contract <ref>`), and CI's `pnpm run check-contract` fails on a hand edit. Use the aliases in `src/contract/index.ts`. They are types only, so nothing reaches the built extension. The daemon's API only changes additively, so an older pin keeps working; re-vendor when you need a new field.
