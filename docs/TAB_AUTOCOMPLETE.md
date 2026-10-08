# Phase 4 — Tab autocomplete / next-edit suggestions (design + recommendation)

Status: **not started** (no Tab commits in tree; `agentHost/.../phase4-plan.md` is the
unrelated provider-registration skeleton). This doc is the grounded design.

## The honest verdict first
Cursor's Tab is a **purpose-trained fast fill-in-the-middle (FIM) model**. Celiador's
agent is **Claude via the daemon**, and **Claude — even Haiku — is not a FIM model.**
A Haiku-backed Tab works but will be: slower than Cursor (network round-trip dominates),
more verbose / less well-filtered (no FIM loss), and a **per-keystroke quota drain** that
competes with the agent's own token budget. Meanwhile the thing Claude is genuinely great
at — multi-line, multi-file, reasoned edits — **already shipped as ⌘I inline edit (Phase 2).**

So Tab is the one Cursor differentiator Celiador can't cheaply match with its current model.

## What already exists (so this is wiring, not core work)
- `InlineCompletionsProvider` interface + `registerInlineCompletionItemProvider` extension
  API (`src/vs/editor/common/languages.ts`; registration from an extension — **no fork edit**).
- Debounce, ghost-text rendering, cancellation, accept/reject (Tab/Esc) — all in baseline
  (`editor/contrib/inlineCompletions/**`), plus the **same provider handles Next-Edit
  Suggestions** via `includeInlineEdits` + `isInlineEdit` (multi-line/side-by-side views exist).
- Settings family `editor.inlineSuggest.*` incl. `.edits.*`; NES accessibility signal.
- Auth/transport reuse: the `celiador` auth provider + daemon bearer (no new login).
- Daemon has the gateway/relay but **no completion endpoint** — a `/api/complete` is net-new.

## Three paths
1. **Defer (recommended now).** Lean on the shipped ⌘I inline edit — it's Claude's strength
   and already Cursor-competitive for "change this." Don't ship a weak Tab as a headline.
2. **Experimental Haiku Tab (small spike, off by default).** Register a
   `CeliadorInlineCompletionsProvider` (celiador-ai extension) → debounced `POST /api/complete`
   (prefix/suffix, Haiku, `max_tokens≈48`, `temperature≈0.2`, stop at newline for single-line) →
   ghost text. ~3 days. Gate behind `celiador.inlineCompletions.experimental` (default off),
   with per-minute + daily caps separate from the agent quota so it can't starve agent turns.
   Market honestly as experimental. Good for learning; not parity.
3. **Real parity (infra bet, only if Tab becomes a priority).** Serve a purpose-built FIM
   code model (Codestral-Fill / Qwen2.5-Coder / DeepSeek-Coder) from the daemon on a GPU,
   behind `/api/complete`. This is the Cursor approach and a genuine infra investment (model
   serving, latency SLOs, cost). Same editor-side provider as path 2 — only the daemon backend
   changes. Pairs naturally with NES (`includeInlineEdits`) once a fast model exists.

## Recommendation
**Now:** path 1 (defer) + optionally path 2 as a flagged spike to gather signal. Keep Tab OFF
by default. **Later:** if usage shows Tab is the gap users feel, commit to path 3 (self-hosted
FIM model) — that's the only way to actually match Cursor's Tab, and it's a deliberate GPU/cost
decision, not a quick win. Do **not** position a Haiku Tab as the Phase 4 headline.

## Smallest-viable slice (if path 2 is chosen)
- `extensions/celiador-ai/src/inlineCompletionsProvider.ts` — provider; cancel prior request on
  new `requestUuid`; early-exit when `!context.includeInlineCompletions`.
- `daemon/src/complete/routes.ts` + `POST /api/complete` in `app.ts` — prefix/suffix → Haiku →
  `{ completion }`; its own rate/daily caps; bodyLimit.
- Register in `extension.ts activate()`; setting + caps in `package.json`.
- Verify in the **packaged app** (latency + acceptance), not just dev.
