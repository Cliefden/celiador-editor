# Celiador Defaults

A built-in extension that ships Celiador's default settings via
`contributes.configurationDefaults` (no activation, no code).

It hides VS Code's built-in AI so only the **celiador-ai** extension surfaces an LLM:

- `chat.disableAIFeatures: true` — hides the native Chat view, the "Sign in to use
  GitHub Copilot" setup modal, the Source Control "Generate Commit Message" button,
  the command-center chat entry, welcome tiles, and MCP/agent-plugin views.
- `chat.agentHost.claudeAgent.enabled: false` / `chat.agentHost.codexAgent.enabled: false`
  — keep the native agent-host Claude/Codex providers from registering.

These are defaults, so a user can still override them. The Copilot agent-host provider,
which has no setting gate, is neutralized separately in
`src/vs/platform/agentHost/node/agentHostMain.ts`.
