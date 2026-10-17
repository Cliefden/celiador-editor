# Workspace Trust and agent-writable configuration

Outcome of the editor#22 audit (2026-10-17). The threat: a cloned repository
carries workspace settings, tasks, or agent hooks that the editor or the agent
executes on open or on the next run (the DuneSlide class, CVSS 9.8).

## What already held, and is now pinned by tests

**Workspace Trust is on.** `security.workspace.trust.enabled` defaults to `true`
(unchanged from upstream, `workspace.contribution.ts`). Trust is a renderer
decision; no electron-main fallback is involved. Upstream's June 2026 change
opens an untrusted folder in Restricted Mode without a prompt
(`security.workspace.trust.startupPrompt: never`), where workspace settings are
filtered and tasks do not run. The prompt comes when something needs trust.

**The agent needs trust before it runs.** `agentHostSessionHandler` gates every
spawn on the session's folders being trusted ("AI features are currently only
supported in trusted workspaces"), prompting per folder. "Run on your editor"
from the phone goes through the same spawn path, so a request for an untrusted
folder prompts on the Mac instead of running. A worktree the editor created
inherits trust from its trusted base repository; nothing else does.

**The host's write auto-approval refuses agent-writable config.** In
`SessionPermissionManager` a write auto-approves only if the literal path
*and* its symlink-resolved real path are inside a session root, outside
platform-restricted locations, and not matched by a denied glob. The
always-checked list (`ALWAYS_CHECKED_EDIT_PATTERNS`, applied after and
regardless of user configuration) holds `.vscode/*.json` (settings, tasks,
launch), `.mcp.json`, `.npmrc`, `.claude/settings.json`,
`.claude/settings.local.json`, `.claude/agents/**`, `.github/{agents,hooks}/**`
and the Codex equivalents. Matching is case-insensitive where the file system
is (macOS, Windows), via `ignorePathCasing`. Null bytes and Windows path tricks
fail closed.

## What this audit changed

- **Git hooks always need approval.** Upstream had `.git/**` only in the
  user-overridable defaults. `**/.git/hooks/**` and `**/.husky/**` are now in
  the always-checked list.
- **`..` segments are normalized before glob matching.** The symlink-resolved
  candidate already normalized them; the literal candidate now does too, so a
  fallback to the literal path cannot be steered past a pattern.
- **The Claude SDK can't skip the host.** The SDK only calls `canUseTool` for
  tools its `permissionMode` does not auto-approve; in `acceptEdits` (entered by
  approving a plan) and `bypassPermissions` it approves file edits itself, so
  the host's list was never consulted. A `PreToolUse` hook
  (`claudeProtectedEdits.ts`) now answers `ask` for file-edit tools on an
  always-checked path, which routes the call to `canUseTool` after all, where
  the host requires the prompt. Same list, same normalization, same casing rule.
- **Tests.** `sessionPermissions.test.ts` covers `..` through protected and
  ordinary files, and git/husky hooks with user patterns approving `.git`;
  `claudeProtectedEdits.test.ts` covers every edit tool, `..`, relative paths
  against the SDK cwd, and mixed case.

## What remains by design

- A session the user set to "Allow All" auto-approves everything, including
  these files. That is an explicit per-session choice, shown in the permission
  picker, and upstream semantics; it is not silently reachable from a repo.
- The Claude SDK reads `.claude/settings.json` from the project
  (`settingSources: user, project, local`), so a repository can define SDK
  hooks that run shell commands during a session. Trust is the boundary: those
  only run once the user has trusted the folder, and the agent cannot change
  them without a prompt. Narrowing `settingSources` for untrusted-origin repos
  is a follow-up if dogfooding shows a need.
- Bash is not path-aware: `echo > .vscode/tasks.json` is governed by the shell
  rules (`sed -i` and redirects to denied destinations require confirmation),
  not by the edit patterns.
