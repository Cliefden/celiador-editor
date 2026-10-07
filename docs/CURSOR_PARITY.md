# Celiador — the Cursor way (parity roadmap)

Celiador's agent is the **native agentHost Claude provider** routed through the
**daemon** gateway, authenticated via the `celiador` auth provider — not GitHub
Copilot. We have removed the Copilot machinery (see branch `celiador-sever-copilot`:
chat-setup dialog/sign-in modal/title-bar/accounts/status-bar/composer affordances)
and added the Celiador Welcome pane. This doc tracks what's left to affirmatively
*feel* like Cursor.

Principles: concentrate + mark core edits (fork stance); guard on product identity
(`nameShort !== 'Code - OSS'`) so upstream rebases stay clean; **verify in the built
app**, not just the dev build; each phase ships independently.

## Phase 0 — Make the agent answer (table stakes; unblocks everything)
- Finish `claudeAgent._refreshModels` daemon path → publish the Celiador model when
  signed in. *(workstream)*
- Model picker shows **Celiador models only** (daemon catalog); drop Copilot/BYOK tabs.
- Verify built-app E2E: install → sign in → SDK provisions → chat streams an answer.
- **Exit:** sign in → ask → streamed answer with tool use, in `Celiador.app`.
- **Status (2026-10-07):** sign in → ask → streamed answer verified in the packaged app
  through the prod daemon gateway (`screenshots/smoke-signed-in-answer.png`). A turn
  that uses tools is not yet verified.

## Phase 1 — First-run & chrome parity (cheap, high perceived value)
- Replace the "Get started with VS Code" walkthrough with a Celiador one; sign-in-first.
- Neutralize residual Microsoft/GitHub surfaces (GitHub auth/STT noise, Settings Sync
  to Microsoft, telemetry endpoints, Accounts menu, Open VSX only, stray GitHub icon).
- Branding sweep: activity bar, command center, About dialog, default settings.
- **Done (branch `celiador-phase1-first-run`):** sign-in-first Setup walkthrough
  (`celiador.signedIn` context key from celiador-ai); dictation off by default (it pulled
  a Microsoft Foundry model); Open VSX `resourceUrlTemplate`; dropped the Microsoft
  `trustedExtensionAuthAccess` entry; Cliefden company/copyright in the app bundle;
  agent UI strings (approvals hover, Local/Claude session descriptions, SDK setup banner
  → "Sign in to Celiador", model-picker update hints); no post-update fetch from
  code.visualstudio.com; no "Ask @vscode". Already off: Settings Sync, telemetry,
  experiments. Kept by decision: the bundled GitHub Pull Requests extension.
- **Remaining:** `defaultChatAgent` in product.json still points at Copilot endpoints
  (called once any GitHub session exists); the `github` and `tunnel-forwarding`
  built-ins; Copilot plan actions in the Command Palette; ~25 lower-visibility
  "VS Code" strings (reload/restart prompts, MCP welcome, issue reporter, settings
  descriptions); a Celiador `documentationUrl`.

## Phase 2 — Inline edit (Cmd-K) + inline diff review
- Audit what `vs/sessions`/agentHost already exposes for inline edit; wire a keybinding
  + widget to the daemon gateway, or build a lightweight inline-edit widget.
- Accept/reject agent edits as inline hunks in the editor (not only the sidebar).

## Phase 3 — Codebase context (moat #1)
- `@`-mentions: files, symbols, folders, git, docs, web.
- Semantic codebase indexing (embeddings) for retrieval. Decision: **daemon-side**
  (fits daemon-as-hub + mobile) vs local. Largest item; its own design.

## Phase 4 — Tab autocomplete (moat #2)
- Model-backed multi-line / next-edit completion via a fast model through the daemon,
  wired to the inline-completions provider. Latency-critical, large; sequence last.

## Phase 5 — Account, usage, privacy
- Account panel: plan + usage/quota (daemon already tracks limits), manage/sign-out.
- Privacy / local-first indicator (hybrid runner).

Recommended order: 0 → 1 now; treat **Phase 3** as the flagship investment; defer 4.
