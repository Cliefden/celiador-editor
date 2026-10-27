# Celiador — Ecosystem Map

Celiador is one loop: **issue in, pull request out.** Label a GitHub issue `celiador` and an agent runs it in its own git worktree on your Mac, comments on the issue, and opens a pull request that closes it; you review and merge from your phone or from the editor's Agents view. The loop is the product. The editor in this repository is one runner for it (the nicest one), the Celiador Remote extension makes stock VS Code and Cursor another, and cloud runs are the third (in progress). The phone is the review surface; GitHub is where the run narrates itself.

The pieces live in **independent repositories**, each with its own build and release cadence, bound by a shared auth + API contract against the daemon.

> This file lives in the editor repository. The umbrella folder's `CLAUDE.md` carries the same map for agents working across repositories.

## The repositories

| Local folder | Repo | Role in the loop |
|---|---|---|
| `daemon` | `Cliefden/daemon` | **The hub.** Slim Hono server behind `celiador.ai/api/*`: GitHub App webhooks (labelled issues become queued tasks), the task queue and dispatch to runners, the agent-session relay (runner publishes, phone watches and steers), the Anthropic agent proxy (holds the key, enforces published per-user limits), Supabase JWT auth, APNs push, profile and chat history, and the editor's release feed. Cloud runs (in progress) run here too. |
| `celiador-editor` | `Cliefden/celiador-editor` | **A runner, and the cockpit.** Hard fork of `microsoft/vscode` with the `celiador-ai` extension built in: picks up queued tasks for the repositories it has open, runs the agent in a worktree, pushes and opens the pull request, and shows every run in the Agents view. This repository. |
| `celiador-remote` | `Cliefden/celiador-remote` | **The same runner for stock VS Code and Cursor.** An ordinary extension (Open VSX `celiador.celiador-remote`) that ports the editor's relay client, auth and git review modules, so people keep their editor and still get the loop. |
| `celiador-ios` | `Cliefden/celiador-ios` | **The review surface.** Celiador for iPhone: the queue (what needs you, what is running, what is ready), the agent's account of the change, the diff, follow-ups, approvals and questions, approve and merge. Push and Live Activity when a run needs you. |
| `celiador-web` | `Cliefden/celiador-web` | **The site** at celiador.ai: the loop explained, the start guide, downloads and release listing, the published limits. |
| `daemon-old` | `Cliefden/daemon-old` *(archived)* | The previous monorepo backend (spec/codegen engine, old native apps, studio UI). Reference only. |
| `celiador-editor-legacy` | `Cliefden/celiador-editor-legacy` *(archived)* | The previous VSCodium build orchestrator. Reference only; the hard fork replaced it. |

## How they fit together

```
 GitHub issue (label `celiador`) ──▶ daemon (webhook → task queue)
                                        │
                 ┌──────────────────────┼─────────────────────────┐
                 ▼                      ▼                         ▼
      celiador-editor           celiador-remote             cloud run (in progress;
      (Agents view)             (VS Code / Cursor)          needs the GitHub App)
                 │  git worktree + Claude agent, via the daemon's agent proxy
                 ▼
      push branch, open PR that closes the issue, comment the link
                 │
                 ▼
      celiador-ios (review, follow-up, approve and merge)  ◀── relay (SSE) ──  daemon
```

Every client authenticates the same way: obtain a Supabase session, send the access token as `Authorization: Bearer`, and the daemon verifies it and isolates state per user. No client holds the model key.

## The contract (single source of truth)

The daemon's `README.md` and `docs/CLIENT_INTEGRATION.md` describe the current endpoints (`/api/tasks`, `/api/sessions`, `/api/agent/messages`, `/api/me`, `/api/limits`, the GitHub App in `docs/GITHUB_APP.md`). Clients consume that contract; they must not redefine it.

## `celiador-ai` source of truth

The editor's `extensions/celiador-ai` is the canonical `celiador-ai` source. The copy inside `celiador-editor-legacy` is frozen with the archive; do not edit it. `celiador-remote` ports selected modules from it and keeps its own copies.

## Dogfood

Every change to Celiador ships through Celiador: work starts as an issue in the relevant repository, labelled `celiador`; an agent runs it in a worktree and opens the pull request; it is reviewed from the phone or the Agents view. See each repository's `CONTRIBUTING.md`.
