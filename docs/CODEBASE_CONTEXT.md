# Phase 3 — Codebase context: design proposal

Status: **decided 2026-10-07 — option A first.** No index for now; revisit D if the
exploratory-search signal shows up. (Original open questions kept at the end.)
Roadmap: `docs/CURSOR_PARITY.md` → Phase 3.

## Phase 3a — shipped (option A)

- **Workspace-symbol tool** (`contrib/chat/browser/tools/workspaceSymbolsTool.ts`,
  `vscode_searchWorkspaceSymbols`, reference name `workspaceSymbols`): fuzzy symbol search
  over the language servers' index, scoped to the workspace / working directory. Member of
  the `vscode-general` tool set, so the Claude agent sees it as an `mcp__client__` tool.
- **Project overview** (`platform/agentHost/node/chatContributions/projectOverview/`): on
  the first turn of each Claude chat, adds the workspace root's top-level layout and, when
  the repo has no `CLAUDE.md` (which the SDK already loads), its `AGENTS.md`.
- **Instrumentation** (`node/claude/claudeExplorationTracker.ts`): every completed Claude
  turn logs `exploration turnId=… beforeFirstEdit=N searches=M toolCalls=K edited=…` to
  the agent host log. Many turns with a high `beforeFirstEdit` is the signal for 3b (D).
- **Known issue (blocks relying on client tools):** in the packaged app, a Claude turn that
  calls any workbench client tool (`workspaceSymbols`, and the pre-existing `usages`) runs
  the tool but then stalls. One cause is fixed here (a completion that beat the SDK's MCP
  handler was dropped; now buffered, `claudeAgentSession.completeClientToolCall`); a second
  run showed the workbench's `ChatToolCallComplete` never reaching the host. Until that is
  fixed the overview does not steer the agent toward the symbol tool.

## What works today (verified 2026-10-07, packaged app)

- **Explicit context works.** The chat input attaches the current file automatically,
  `#file:` references and the **+ (Add Context)** button attach files/symbols/folders, and
  the Claude agent receives them (asked "what does `#file:util.ts` export?" → correct
  answer; the trace shows it reading `util.ts`).
- **The agent searches on its own.** The Claude agent has its SDK tools —
  `Grep`, `Glob`, `Read`, `LS`, `Task` (sub-agents) — and explores the repo agentically,
  the way Claude Code does. It needs no index to find code by name or text.
- **No semantic ("search by meaning") retrieval.** There is no embeddings index.

## What the fork already has to build on

| Hook | Where | State in Celiador |
|---|---|---|
| Agent-host "client semantic search" tool: the workbench forwards a `copilot_searchCodebase` tool to agent-host sessions as `semantic_search` | `platform/agentHost/common/semanticSearchConstants.ts`, `agentHostActiveClientService.ts:291,374-395`, `agentHostSessionHandler.ts` | Gated to **Copilot sessions only** (`isCopilotSession`) and the tool itself is implemented by the Copilot Chat extension, which is not shipped → absent |
| Embedding provider API (`IAiEmbeddingVectorService`, extension proposal `aiEmbeddingVector`) | `services/aiEmbeddingVector/common/aiEmbeddingVectorService.ts`, `api/browser/mainThreadAiEmbeddingVector.ts` | No provider registered |
| Search view "semantic results" (`search.searchView.semanticSearchBehavior`) | `contrib/search/browser/searchView.ts` | No provider → never shows |

So a Celiador implementation slots in as: **a language-model tool (from `celiador-ai`) +
lifting the Copilot-only gate**, optionally also feeding the Search view.

## Options

### A. Agentic search only (today) + better grounding — *no index*
Keep Grep/Glob/Read. Improve grounding cheaply: a generated project summary / instructions
file the agent reads first, `@`-context affordances, maybe an LSP-backed symbol-search tool
(workspace symbols are already computed by the language servers).
- **+** zero infra, zero privacy surface, nothing to keep in sync, works offline.
- **−** weak on "where is the code that does X?" in large unfamiliar repos; spends tokens
  and latency on exploratory greps.

### B. Local index, local embedding model — *everything on the machine*
Chunk the workspace, embed with a small on-device model (ONNX/transformers.js class,
~30–150 MB), store vectors in workspace storage, serve the `semantic_search` tool locally.
- **+** private, offline, no server cost, fits the agreed **local-first hybrid** stance.
- **−** app size and CPU/battery while indexing; small-model quality is below hosted
  embeddings; cloud runs and the iPhone get nothing from it.

### C. Daemon-side index — *code uploaded to the server*
The daemon chunks + embeds repos (hosted embedding API — Anthropic has none, so Voyage or
similar) and stores vectors per user/repo; editor, cloud runs and iPhone all query it.
- **+** one index for every client; best quality; matches "daemon as hub".
- **−** customer code stored server-side (privacy, security review, deletion obligations);
  server storage and embedding cost per repo; keeping it in sync with unsaved/local edits is
  hard; a new vendor key.

### D. Hybrid — *index local, embeddings via the daemon*
Chunking, vector store and search run locally (as B); only the embedding call goes through
the daemon gateway (chunks are sent transiently to the embedding API, **not stored**).
Cloud runs reuse the same indexer on their server-side clone.
- **+** hosted-quality embeddings without storing code server-side; small app; daemon
  meters cost per user like the agent; same code path for desktop and cloud runs.
- **−** code chunks do leave the machine (to the daemon and the embedding vendor) at index
  time; needs a vendor key on the daemon; offline indexing degrades to A.

## Recommendation

1. **Now (Phase 3a): A.** It is cheap and immediately useful, and the agent already handles
   most lookups. Ship: an LSP workspace-symbol tool for the agent, and a short auto-generated
   project overview it reads first. Instrument how often sessions spend many exploratory
   `Grep`/`Glob` calls before the first edit — that's the signal semantic search is needed.
2. **If that signal is real (Phase 3b): D**, behind a setting, with the index local and
   embeddings metered through the daemon. Implement it as the `semantic_search` tool from
   `celiador-ai` and lift the Copilot-only gate for the Claude session type.
3. **Avoid C** unless there's a strong product reason to hold customer code on the server —
   it contradicts the local-first stance and adds the heaviest obligations.

## Decisions needed

1. **Is sending code chunks to a third-party embedding API (through the daemon) acceptable**
   for Celiador's users? If not, the choice is A or B (local model, larger app).
2. **Do cloud runs / the iPhone need semantic search** soon? If yes, that pushes toward D
   (shared indexer) rather than B.
3. **Go with A first** (recommended), or start directly on an index?
