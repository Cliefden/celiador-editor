# Decision: Celiador does not build a bespoke Tab completion model

**Status:** Decided (Phase 0, 2026-10-10). Revisit only on the triggers below.

## Decision

Celiador will **not** build, train, or serve its own inline autocomplete ("Tab")
model. We ship an **agent-first** product. Inline completion, if offered at all,
rides an off-the-shelf fill-in-the-middle model behind the daemon — never a
custom-trained one.

## Why

- **The moat is unreachable by design.** Cursor's Tab is a proprietary model
  trained with online RL on ~400M accept/reject events per day. That flywheel —
  data volume × a dedicated serving stack tuned to sub-300ms — is the output of
  a two-year, GPU-heavy effort now backed by SpaceX's fleet. Spending our effort
  chasing it is how we lose on our actual strengths.
- **It's off-thesis.** Our three wedges (see the surpass-Cursor plan) are
  Claude-native agents, deep remote command of local-first agents, and conduct.
  A completion model advances none of them; it's a commodity race where the
  incumbent has an insurmountable data lead.
- **Latency + cost we can't win.** A good Tab needs a fine-tuned small model
  served at single-digit-ms-to-first-token from our own infra. We hold one box
  and a shared Anthropic key metered per user — the wrong shape for high-QPS,
  low-latency completion, and a direct hit to unit economics.
- **The market already moved.** Cursor's own marketing repositioned from "AI
  code editor" to "coding agent." The center of gravity is the agent loop, which
  is exactly where Claude is strongest and where we compete.

## What we do instead

- **Invest in the agent loop**: the Agents Window cockpit, agent-review git,
  deep mobile steering. That's where differentiation compounds.
- **Keep the editor's upstream IntelliSense / LSP completions** — real,
  deterministic, free, and already in the fork. We do not disable them.
- If user demand for inline AI completion proves real, offer it as a **thin,
  optional** layer over a hosted FIM model (e.g. a small open model behind the
  daemon), off by default, with its own quota line — not a trained-in-house
  system, and not on the critical path.

## Revisit triggers

Reopen this decision only if **one** of these becomes true:

1. A hosted FIM model good enough for inline completion is available at a
   per-token cost and latency that fit the daemon's shared-key economics (so we
   can offer it without owning a serving stack).
2. User research shows inline completion — not agent quality — is the top
   reason prospects choose a competitor over Celiador.
3. Our infrastructure posture changes fundamentally (dedicated low-latency
   inference capacity), making custom serving viable.

Absent those, the answer stays no. Effort goes to the agent.
