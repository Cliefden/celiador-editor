# Celiador — Ecosystem Map

Celiador is one product split across **three independent repositories** plus shared
assets. They are intentionally kept as separate repos (each has its own build and
release cadence) but are bound together by a single auth + API contract.

> This file is duplicated verbatim in every Celiador repo. Keep them in sync.

## The repositories

| Local folder | Repo | Role |
|---|---|---|
| `celiador-editor` | `Cliefden/celiador` | **The editor** — hard fork of `microsoft/vscode` (baseline 1.138.0). Ships the built-in `celiador-ai` extension (`extensions/celiador-ai`). This is the shipping desktop client. |
| `celiador-backend` | `Cliefden/celiador-daemon` | **The backend/platform** — `packages/core` (spec + codegen engine), `packages/daemon` (HTTP+SSE server on :4661, Supabase JWT, APNs), `packages/cli`, native `apps/apple` (iOS + macOS + widgets), and the `ui/` web workbench. |
| `celiador-editor-legacy` | `Cliefden/celiador-editor` *(archived)* | **Reference only** — the previous VSCodium build orchestrator (70 patches). Superseded by the hard fork. Do not develop here; kept for patch reference. |

Shared assets (not repos):

- `celiador-templates` — Next.js codegen/starter templates (Portfolio, e-commerce, …).

Separate product (not part of Celiador): `Apps-Test/Celiador/Sentinel`.

## How they fit together

```
 clients                        backend (celiador-backend)
 ────────                       ───────────────────────────
 celiador-editor  ─┐
 apps/apple (iOS) ─┼─ Bearer(Supabase JWT) ─▶  daemon :4661  ──▶ @celiador/core (spec/codegen)
 ui/ (web)        ─┘                              │  ├─ Anthropic API (shared server key)
                                                  │  ├─ Supabase / GoTrue (multi-tenant auth)
                                                  └─▶ APNs (alerts + Live Activity)
```

Every client authenticates the same way: obtain a Supabase session, send the
access token as `Authorization: Bearer`, and the daemon verifies it with
`SUPABASE_JWT_SECRET` and isolates state per user.

## The contract (single source of truth)

The authoritative auth + API contract lives in **`celiador-backend/docs/AUTH.md`**.
Clients (editor, native, web) consume it — they must not redefine it.

## `celiador-ai` source of truth

The editor's `extensions/celiador-ai` is the canonical `celiador-ai` source.
The identical copy inside `celiador-editor-legacy` is frozen with the archive —
do not edit it or let the two diverge.
