import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Auth } from "./auth";
import { registerCeliadorAuthProvider } from "./authProvider";
import { SessionRelay } from "./relay";
import { DaemonApi } from "./api";
import { resolveDaemonUrl } from "./productConfig";
import { classifyOutcome, routeEffort, type Outcome } from "./jev";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_READ_BYTES = 512 * 1024;
const MAX_HOPS = 25;

let secretStore: vscode.SecretStorage | undefined;
let auth: Auth | undefined;

// ---- Config -----------------------------------------------------------------

function daemonConfig(): { url: string; token: string } {
  const cfg = vscode.workspace.getConfiguration("celiador");
  return { url: resolveDaemonUrl(), token: cfg.get<string>("token") || "" };
}

function agentConfig(): { provider: string; model: string; effort: string; autoApprove: boolean } {
  const cfg = vscode.workspace.getConfiguration("celiador");
  return {
    provider: cfg.get<string>("provider") || "anthropic",
    model: cfg.get<string>("model") || "claude-opus-4-8",
    effort: cfg.get<string>("effort") || "high",
    autoApprove: cfg.get<boolean>("autoApproveEdits") ?? false,
  };
}

/** Resolution order: SecretStorage → setting → env var. */
async function getApiKey(): Promise<string> {
  const secret = await secretStore?.get("celiador.apiKey");
  if (secret) return secret;
  const cfg = vscode.workspace.getConfiguration("celiador").get<string>("apiKey");
  if (cfg) return cfg;
  return process.env.ANTHROPIC_API_KEY || "";
}

function jevConfig(): { enabled: boolean; routeEffort: boolean; classifyOutcome: boolean; minConfidence: number } {
  const cfg = vscode.workspace.getConfiguration("celiador.jev");
  return {
    enabled: cfg.get<boolean>("enabled") ?? false,
    routeEffort: cfg.get<boolean>("routeEffort") ?? true,
    classifyOutcome: cfg.get<boolean>("classifyOutcome") ?? true,
    minConfidence: cfg.get<number>("minConfidence") ?? 0.6,
  };
}

/** Jev key: SecretStorage → TYPESAFE_API_KEY. Empty string → Jev disabled. */
async function getJevKey(): Promise<string> {
  return (await secretStore?.get("celiador.jevApiKey")) || process.env.TYPESAFE_API_KEY || "";
}

async function probeDaemon(): Promise<string> {
  const { url, token } = daemonConfig();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/health`, { headers });
  if (!res.ok) throw new Error(`/api/health → HTTP ${res.status}`);
  const health: any = await res.json();
  return `Connected to ${url} (status: ${health?.status ?? health?.ok ?? "ok"}).`;
}

// ---- Path safety ------------------------------------------------------------

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Resolve a caller-supplied path, guaranteeing it stays inside the workspace. */
function resolveInWorkspace(root: vscode.Uri, p: string): vscode.Uri {
  const rel = String(p ?? "").trim();
  if (!rel) throw new Error("Empty path.");
  if (rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error("Path must be relative to the workspace root.");
  }
  const target = vscode.Uri.joinPath(root, rel); // normalizes any ".." segments
  const rootPrefix = root.path.endsWith("/") ? root.path : root.path + "/";
  if (target.path !== root.path && !target.path.startsWith(rootPrefix)) {
    throw new Error("Path escapes the workspace root.");
  }
  return target;
}

/** Case-insensitive: APFS/NTFS are, so `.GIT/hooks` must not slip past. */
function isProtectedPath(rel: string): boolean {
  return /(^|[\\/])\.git([\\/]|$)/i.test(rel) || /(^|[\\/])node_modules([\\/]|$)/i.test(rel);
}

/**
 * Symlink guard for local (file:) workspaces: the lexical check in
 * resolveInWorkspace can't see that `src/link -> /etc` leaves the workspace.
 * Resolve the real path of the target — or, for a file that doesn't exist yet,
 * of its nearest existing ancestor — and require it to stay under the real root.
 */
async function assertRealPathInside(root: vscode.Uri, target: vscode.Uri): Promise<void> {
  if (root.scheme !== "file" || target.scheme !== "file") return;
  const realRoot = await fs.promises.realpath(root.fsPath);
  let probe = target.fsPath;
  for (;;) {
    try {
      const real = await fs.promises.realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new Error("Path resolves outside the workspace (symlink).");
      }
      if (isProtectedPath(path.relative(realRoot, real))) {
        throw new Error("Path resolves inside .git or node_modules.");
      }
      return;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
}

// ---- Tools ------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_files",
    description:
      "List files in the current workspace (recursively), optionally under a subdirectory. Returns paths relative to the workspace root. Skips node_modules, .git, and build output.",
    input_schema: { type: "object", properties: { dir: { type: "string", description: "Subdirectory relative to the workspace root. Omit for the whole workspace." } } },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file (max 512 KB). Path is relative to the workspace root.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given contents (creating parent directories). Path is relative to the workspace root. The user reviews changes via source control; writes to .git and node_modules are refused.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
];

interface ToolCtx {
  root: vscode.Uri;
  ensureWrite: (rel: string) => Promise<boolean>;
  changed: Set<string>;
}

async function execTool(name: string, input: any, ctx: ToolCtx): Promise<{ text: string; isError?: boolean }> {
  try {
    if (name === "list_files") {
      const sub = String(input?.dir || "").replace(/^\/+/, "");
      if (sub) resolveInWorkspace(ctx.root, sub); // validate
      const pattern = new vscode.RelativePattern(ctx.root, sub ? `${sub}/**/*` : "**/*");
      const uris = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git,dist,out,.expo,.build}/**", 500);
      const rel = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
      return { text: rel.length ? rel.join("\n") : "(no files)" };
    }
    if (name === "read_file") {
      const uri = resolveInWorkspace(ctx.root, input.path);
      await assertRealPathInside(ctx.root, uri);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_READ_BYTES) {
        return { text: `File is ${stat.size} bytes (limit ${MAX_READ_BYTES}). Read a smaller file or a specific section.`, isError: true };
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      return { text: Buffer.from(bytes).toString("utf8") };
    }
    if (name === "write_file") {
      const uri = resolveInWorkspace(ctx.root, input.path);
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (isProtectedPath(rel)) return { text: `Refusing to write inside .git or node_modules (${rel}).`, isError: true };
      await assertRealPathInside(ctx.root, uri);
      if (!(await ctx.ensureWrite(rel))) return { text: `The user declined the write to ${rel}.`, isError: true };
      await assertRealPathInside(ctx.root, uri); // re-check: the tree may have changed while the user decided
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(String(input.content ?? ""), "utf8"));
      ctx.changed.add(rel);
      return { text: `Wrote ${rel}` };
    }
    return { text: `Unknown tool: ${name}`, isError: true };
  } catch (err: any) {
    return { text: `Tool ${name} failed: ${err?.message ?? err}`, isError: true };
  }
}

// ---- Anthropic call (with retry/backoff) ------------------------------------

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

async function callModel(endpoint: string, headers: Record<string, string>, body: any, signal: AbortSignal): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(endpoint, { method: "POST", signal, headers, body: JSON.stringify(body) });
    } catch (e: any) {
      if (signal.aborted) throw e;
      lastErr = e;
      if (attempt < 3) { await delay(500 * 2 ** attempt, signal); continue; }
      throw e;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get("retry-after"));
      // A long Retry-After (e.g. the daemon's daily quota) means "not now" — report it
      // instead of silently blocking the task for hours.
      if (ra > 60) return res;
      await delay(ra ? ra * 1000 : 500 * 2 ** attempt, signal);
      continue;
    }
    return res; // non-retryable non-OK — caller reports
  }
  throw lastErr;
}

// ---- Agent loop -------------------------------------------------------------

const SYSTEM_PROMPT = `You are Celiador, an AI coding agent embedded in the user's editor. You work directly on the code in their open workspace.

- Use the tools to explore and edit the real files: list_files, read_file, write_file. All paths are relative to the workspace root; you cannot access anything outside it.
- When the user asks for a change, make it by writing files — the user reviews your edits through source control.
- Keep edits minimal and focused on what was asked. Don't refactor or add abstractions beyond the request.
- Lead with the outcome. After finishing, give a short summary of what you changed and why.`;

type Emit = (msg: any) => void;

/**
 * Run one agent turn. Resolves true when the model stopped on its own (a real
 * final answer), false on any early exit (auth/HTTP error, refusal, hop limit).
 */
async function runAgentTurn(messages: any[], emit: Emit, signal: AbortSignal, ctx: ToolCtx, effortOverride?: string): Promise<boolean> {
  const { provider, model, effort: configuredEffort } = agentConfig();
  const effort = effortOverride ?? configuredEffort;

  let endpoint: string;
  let getHeaders: () => Promise<Record<string, string>>;
  let buildBody: () => any;
  const daemonMode = provider === "daemon";

  if (daemonMode) {
    const { url, token } = daemonConfig();
    const signedIn = auth ? await auth.isSignedIn() : false;
    if (!signedIn && !token) {
      emit({ type: "reply", text: "Sign in to use the daemon: run “Celiador: Sign In”. (Or set `celiador.token` for the shared-secret fallback.)" });
      void vscode.commands.executeCommand("celiador.signIn");
      return false;
    }
    endpoint = `${url}/api/agent/messages`;
    getHeaders = async () => {
      const bearer = signedIn && auth ? await auth.getAccessToken() : token;
      return { Authorization: `Bearer ${bearer}`, "content-type": "application/json" };
    };
    // The daemon owns the system prompt, tool set and model (it ignores these
    // fields); they're still sent so an older daemon build keeps working.
    buildBody = () => ({ system: SYSTEM_PROMPT, tools: TOOLS, messages });
  } else {
    const apiKey = await getApiKey();
    if (!apiKey) {
      emit({ type: "reply", text: "No Anthropic API key set. Run “Celiador: Set API Key” (OS keychain), set `celiador.apiKey`, or export ANTHROPIC_API_KEY — or switch `celiador.provider` to \"daemon\"." });
      return false;
    }
    endpoint = ANTHROPIC_URL;
    getHeaders = async () => ({ "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" });
    buildBody = () => ({
      model,
      max_tokens: 32000,
      stream: true,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
      tools: TOOLS,
      messages,
    });
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (signal.aborted) return false;
    let res = await callModel(endpoint, await getHeaders(), buildBody(), signal);
    // Expired daemon JWT → refresh once and retry.
    if (res.status === 401 && daemonMode && auth && (await auth.tryRefresh())) {
      res = await callModel(endpoint, await getHeaders(), buildBody(), signal);
    }

    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      emit({ type: "reply", text: `${daemonMode ? "Daemon" : "Anthropic"} error ${res.status}: ${t.slice(0, 500)}` });
      return false;
    }

    const blocks: Record<number, any> = {};
    let stopReason: string | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev: any;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === "content_block_start") {
          const cb = ev.content_block;
          blocks[ev.index] =
            cb.type === "tool_use" ? { type: "tool_use", id: cb.id, name: cb.name, _json: "" }
            : cb.type === "thinking" ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" };
        } else if (ev.type === "content_block_delta") {
          const b = blocks[ev.index];
          const d = ev.delta;
          if (!b) continue;
          if (d.type === "text_delta") { b.text += d.text; emit({ type: "delta", text: d.text }); }
          else if (d.type === "thinking_delta") { b.thinking += d.thinking; }
          else if (d.type === "signature_delta") { b.signature += d.signature; }
          else if (d.type === "input_json_delta") { b._json += d.partial_json; }
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        }
      }
    }

    const content: any[] = Object.keys(blocks).map(Number).sort((a, b) => a - b).map((i) => {
      const b = blocks[i];
      if (b.type === "tool_use") {
        let parsed: any = {};
        try { parsed = b._json ? JSON.parse(b._json) : {}; } catch { parsed = {}; }
        return { type: "tool_use", id: b.id, name: b.name, input: parsed };
      }
      if (b.type === "thinking") return { type: "thinking", thinking: b.thinking, signature: b.signature };
      return { type: "text", text: b.text };
    });
    messages.push({ role: "assistant", content });

    if (stopReason === "refusal") { emit({ type: "reply", text: "(The model declined this request.)" }); return false; }

    const toolUses = content.filter((c) => c.type === "tool_use");
    // Natural end: the caller emits "done" (possibly with a Jev outcome).
    if (stopReason !== "tool_use" || toolUses.length === 0) { return true; }

    const results: any[] = [];
    for (const tu of toolUses) {
      if (signal.aborted) return false;
      emit({ type: "tool", name: tu.name, input: tu.input, id: tu.id });
      const r = await execTool(tu.name, tu.input, ctx);
      emit({ type: "toolResult", name: tu.name, ok: !r.isError, id: tu.id });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.text, is_error: r.isError });
    }
    messages.push({ role: "user", content: results });
  }
  emit({ type: "reply", text: "(Stopped after too many tool iterations.)" });
  return false;
}

// ---- Chat webview -----------------------------------------------------------

class CeliadorChatViewProvider implements vscode.WebviewViewProvider {
  private messages: any[] = [];
  private controller: AbortController | undefined;
  private running = false;
  private view: vscode.WebviewView | undefined;

  constructor(private readonly relay: SessionRelay) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "send") {
        await this.runTask(String(msg.text || "").trim());
      } else if (msg?.type === "stop") {
        this.cancel();
      } else if (msg?.type === "reset") {
        if (!this.running) {
          this.messages = [];
          this.relay.reset();
        }
      }
    });
  }

  /** Abort the in-flight run (from the Stop button or a remote cancel). */
  cancel(): void {
    this.controller?.abort();
  }

  /** Start a task from a remote (phone) instruction — mirrors a local send. */
  async runFromRemote(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.running) return;
    this.view?.webview.postMessage({ type: "user", text: trimmed });
    await this.runTask(trimmed);
  }

  /** Post a message to the webview (if open) and mirror it to the relay. */
  private emit: Emit = (msg) => {
    this.view?.webview.postMessage(msg);
    this.relayPublish(msg);
  };

  /** Translate a webview message into a session-log event for watchers. */
  private relayPublish(msg: any): void {
    switch (msg?.type) {
      case "delta": this.relay.publish({ kind: "delta", text: msg.text }); break;
      case "tool": this.relay.publish({ kind: "tool", callId: msg.id ?? "", name: msg.name, input: msg.input }); break;
      case "toolResult": this.relay.publish({ kind: "toolResult", callId: msg.id ?? "", ok: msg.ok }); break;
      case "reply": this.relay.publish({ kind: "message", role: "assistant", text: msg.text }); break;
      case "running": if (msg.value) this.relay.publish({ kind: "state", state: "running" }); break;
      case "done":
        if (msg.finalState === "error" || msg.finalState === "cancelled") {
          // One terminal state per run: a failed/stopped run must not also report "done".
          this.relay.publish({ kind: "state", state: msg.finalState });
        } else if (msg.outcome === "needs_user_input" || msg.outcome === "blocked") {
          // The agent stopped but is waiting on the user: surface it as a question
          // (the phone gets a "Celiador has a question" alert) rather than "Task finished".
          // The phone's reply comes back as an answer/instruct and starts a follow-up turn.
          this.relay.publish({ kind: "question", requestId: this.relay.newRequestId(), prompt: msg.prompt ?? "Celiador needs your input." });
          this.relay.publish({ kind: "state", state: "awaiting" });
        } else {
          this.relay.publish({ kind: "state", state: "done" });
          this.relay.publish({ kind: "done" });
        }
        break;
    }
  }

  /** Text of the last assistant message in the conversation (for outcome classification). */
  private lastAssistantText(): string {
    const last = [...this.messages].reverse().find((m) => m.role === "assistant");
    if (!last || !Array.isArray(last.content)) return "";
    return last.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
  }

  private async runTask(text: string): Promise<void> {
    if (!text || this.running) return;
    const root = workspaceRoot();
    if (!root) { this.emit({ type: "reply", text: "Open a folder first — the agent works on files in your workspace." }); return; }

    this.running = true;
    this.controller = new AbortController();
    // Create/attach the relay session (best-effort) before the first event so
    // the phone sees the run from its start.
    await this.relay.start(text);
    this.emit({ type: "running", value: true });
    const priorTurns = this.messages.filter((m) => m.role === "user" && typeof m.content === "string").length;
    this.messages.push({ role: "user", content: text });

    // Jev: route reasoning effort for this task (direct Anthropic only — the daemon picks its own).
    const jev = jevConfig();
    const jevKey = jev.enabled ? await getJevKey() : "";
    let effortOverride: string | undefined;
    if (jevKey && jev.routeEffort && agentConfig().provider === "anthropic") {
      const d = await routeEffort(jevKey, text, priorTurns, jev.minConfidence);
      if (d) {
        effortOverride = d.choice;
        this.emit({ type: "note", text: `effort: ${d.choice} (Jev, ${d.confidence.toFixed(2)})` });
      }
    }

    let approveAll = false;
    const { autoApprove } = agentConfig();
    const ctx: ToolCtx = {
      root,
      changed: new Set<string>(),
      ensureWrite: async (rel) => {
        if (autoApprove || approveAll) return true;
        // Ask both the desktop (modal) and the phone (relay); first wins.
        const requestId = this.relay.newRequestId();
        this.relay.publish({ kind: "approval", requestId, approvalKind: "write_file", path: rel });
        this.relay.publish({ kind: "state", state: "awaiting" });
        // Once the phone has decided, a later click on the (now stale) desktop
        // modal must not take effect — in particular not "Allow all".
        let settled = false;
        const local = (async () => {
          const choice = await vscode.window.showWarningMessage(
            `Celiador wants to write:\n${rel}`,
            { modal: true, detail: "Applied to your working tree — review it in source control." },
            "Allow",
            "Allow all in this task"
          );
          if (settled) return false;
          if (choice === "Allow all in this task") { approveAll = true; return true; }
          return choice === "Allow";
        })();
        const ok = this.relay.active ? await Promise.race([local, this.relay.waitForApproval(requestId)]) : await local;
        settled = true;
        this.relay.clearApproval(requestId);
        this.relay.publish({ kind: "state", state: "running" });
        return ok;
      },
    };

    let outcome: Outcome | undefined;
    let finalText = "";
    // The run's single terminal state, relayed once in `finally`.
    let finalState: "done" | "error" | "cancelled" = "done";
    const signal = this.controller.signal;
    try {
      const endedNaturally = await runAgentTurn(this.messages, this.emit, signal, ctx, effortOverride);
      if (!endedNaturally) finalState = signal.aborted ? "cancelled" : "error";
      // Jev: did this turn really finish, or is the agent waiting on the user?
      if (endedNaturally && jevKey && jev.classifyOutcome) {
        finalText = this.lastAssistantText();
        const d = finalText ? await classifyOutcome(jevKey, finalText, [...ctx.changed], jev.minConfidence) : undefined;
        if (d) {
          outcome = d.choice;
          this.emit({ type: "note", text: `outcome: ${d.choice} (Jev, ${d.confidence.toFixed(2)})` });
        }
      }
    } catch (err: any) {
      if (signal.aborted) {
        this.emit({ type: "reply", text: "(Stopped.)" });
        finalState = "cancelled";
      } else {
        this.emit({ type: "reply", text: `Error: ${err?.message ?? err}` });
        finalState = "error";
      }
    } finally {
      if (ctx.changed.size) this.emit({ type: "reply", text: `Changed ${ctx.changed.size} file(s): ${[...ctx.changed].join(", ")}` });
      this.running = false;
      this.controller = undefined;
      this.emit({ type: "running", value: false });
      this.emit({ type: "done", finalState, outcome, prompt: finalText.slice(-500) || undefined });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  #log { flex: 1; overflow-y: auto; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .you { background: var(--vscode-input-background); }
  .celiador { background: var(--vscode-editorWidget-background); }
  .tool { opacity: 0.8; font-size: 12px; font-family: var(--vscode-editor-font-family); }
  .role { font-size: 10px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; }
  #row { display: flex; gap: 6px; margin-top: 8px; }
  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; border-radius: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #stop { background: var(--vscode-inputValidation-errorBackground, #a1260d); display: none; }
</style>
</head>
<body>
  <div id="log">
    <div class="msg celiador"><div class="role">celiador</div>I'm your coding agent. Ask me to explore or change the code in this workspace — I'll edit files directly (with your approval) and you review the changes in source control.</div>
  </div>
  <div id="row">
    <input id="input" type="text" placeholder="Ask Celiador to build or change something…" />
    <button id="send">Send</button>
    <button id="stop">Stop</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  let current = null;

  function bubble(role) {
    const el = document.createElement('div');
    el.className = 'msg ' + (role === 'you' ? 'you' : 'celiador');
    const r = document.createElement('div'); r.className = 'role'; r.textContent = role;
    const body = document.createElement('div');
    el.appendChild(r); el.appendChild(body); log.appendChild(el); log.scrollTop = log.scrollHeight;
    return body;
  }
  function line(cls, text) {
    const el = document.createElement('div'); el.className = 'msg celiador ' + cls; el.textContent = text;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
  }
  function send() {
    const text = input.value.trim(); if (!text) return;
    bubble('you').textContent = text;
    vscode.postMessage({ type: 'send', text }); input.value = ''; current = null;
  }
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'user') { bubble('you').textContent = m.text; current = null; }
    else if (m.type === 'delta') { if (!current) current = bubble('celiador'); current.textContent += m.text; log.scrollTop = log.scrollHeight; }
    else if (m.type === 'note') { line('tool', '· ' + m.text); current = null; }
    else if (m.type === 'tool') { line('tool', '→ '+ m.name + '(' + (m.input && (m.input.path || m.input.dir) || '') + ')'); current = null; }
    else if (m.type === 'reply') { bubble('celiador').textContent = m.text; current = null; }
    else if (m.type === 'running') { sendBtn.disabled = m.value; input.disabled = m.value; stopBtn.style.display = m.value ? 'block' : 'none'; }
    else if (m.type === 'done') { current = null; }
  });
</script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  console.log("[celiador-ai] activated");
  secretStore = context.secrets;
  auth = new Auth(context.secrets);

  // Relay: makes a local agent run observable/controllable from the companion
  // phone. The token is the signed-in Supabase access token, falling back to the
  // shared-secret setting; undefined → signed out, so the run stays local-only.
  const relay = new SessionRelay(
    () => daemonConfig().url,
    async () => {
      try {
        if (auth && (await auth.isSignedIn())) return await auth.getAccessToken();
      } catch {
        /* fall through to shared token */
      }
      return daemonConfig().token || undefined;
    }
  );
  const provider = new CeliadorChatViewProvider(relay);
  relay.onInstruct = (text) => void provider.runFromRemote(text);
  relay.onCancel = () => provider.cancel();
  context.subscriptions.push({ dispose: () => relay.dispose() });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("celiador.chat", provider));

  // Expose the Supabase session as a VS Code authentication provider so the native
  // Agents Window can resolve a token for the daemon's `celiador-daemon` resource
  // and route the Claude agent through the daemon. Sign-in still happens via the
  // extension's own UI; this only surfaces the resulting session + its changes.
  context.subscriptions.push(registerCeliadorAuthProvider(auth));

  // Capture the Supabase OAuth / magic-link deep link (celiador://…/auth-callback).
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (!auth) return;
        if (await auth.handleCallback(uri)) {
          void vscode.window.showInformationMessage(`Signed in to Celiador as ${(await auth.currentEmail()) ?? "your account"}.`);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.openChat", async () => {
      await vscode.commands.executeCommand("celiador.chat.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "Anthropic API key for Celiador", password: true, ignoreFocusOut: true });
      if (key && key.trim()) {
        await secretStore?.store("celiador.apiKey", key.trim());
        void vscode.window.showInformationMessage("Celiador API key saved to the OS keychain.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.setJevApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "TypeSafe AI (Jev) API key for Celiador", password: true, ignoreFocusOut: true });
      if (key && key.trim()) {
        await secretStore?.store("celiador.jevApiKey", key.trim());
        void vscode.window.showInformationMessage("Jev API key saved to the OS keychain. Enable it with `celiador.jev.enabled`.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.signIn", async () => {
      if (!auth) return;
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Sign in — email & password", id: "password" },
          { label: "Create account — email & password", id: "signup" },
          { label: "Magic link (email)", id: "magic" },
          { label: "GitHub", id: "github" },
        ],
        { placeHolder: "Sign in to Celiador" }
      );
      if (!pick) return;
      try {
        if (pick.id === "github") { await auth.signInWithGitHub(); return; }
        const email = (await vscode.window.showInputBox({ prompt: "Email", ignoreFocusOut: true }))?.trim();
        if (!email) return;
        if (pick.id === "magic") {
          await auth.sendMagicLink(email);
          void vscode.window.showInformationMessage("Magic link sent — open the link in your email to finish signing in.");
          return;
        }
        const password = await vscode.window.showInputBox({ prompt: "Password", password: true, ignoreFocusOut: true });
        if (!password) return;
        if (pick.id === "signup") {
          const active = await auth.signUp(email, password);
          void vscode.window.showInformationMessage(active ? "Account created and signed in." : "Account created — confirm via the email we sent, then sign in.");
        } else {
          await auth.signInWithPassword(email, password);
          void vscode.window.showInformationMessage(`Signed in as ${email}.`);
        }
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Sign-in failed: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.signOut", async () => {
      await auth?.signOut();
      void vscode.window.showInformationMessage("Signed out of Celiador.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.checkConnection", async () => {
      try { void vscode.window.showInformationMessage(await probeDaemon()); }
      catch (err: any) { void vscode.window.showErrorMessage(`Celiador daemon unreachable: ${err?.message ?? err}`); }
    })
  );

  // App data (profile + chat history) served by the daemon over the shared JWT.
  const api = new DaemonApi(auth, () => daemonConfig().url);

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.account", async () => {
      if (!auth || !(await auth.isSignedIn())) {
        void vscode.window.showInformationMessage("Not signed in. Run “Celiador: Sign In”.");
        return;
      }
      try {
        const p = await api.getProfile();
        void vscode.window.showInformationMessage(
          `Celiador — ${p.display_name ?? p.email ?? p.id} · plan: ${p.plan}`
        );
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't load your profile: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.pastChats", async () => {
      if (!auth || !(await auth.isSignedIn())) {
        void vscode.window.showInformationMessage("Sign in to see your Celiador chat history.");
        return;
      }
      try {
        const chats = await api.listChats();
        if (chats.length === 0) {
          void vscode.window.showInformationMessage("No past chats yet.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          chats.map((c) => ({
            label: c.title || "Untitled task",
            description: new Date(c.updated_at).toLocaleString(),
            detail: c.status,
            id: c.id,
          })),
          { placeHolder: "Open a past Celiador chat" }
        );
        if (!pick) return;
        const { chat, messages } = await api.getChat(pick.id);
        const body = messages
          .map((m) => `### ${m.role}\n\n${(m.content as { text?: string })?.text ?? ""}`)
          .join("\n\n");
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `# ${chat.title ?? "Chat"}\n\n${body || "_No messages._"}`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't load chats: ${err?.message ?? err}`);
      }
    })
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(sparkle) Celiador";
  status.tooltip = "Open Celiador chat";
  status.command = "celiador.openChat";
  status.show();
  context.subscriptions.push(status);

  // Account status item — reflects signed-in state.
  const authStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  const updateAuthStatus = async () => {
    const email = await auth?.currentEmail();
    if (email) {
      authStatus.text = `$(account) ${email}`;
      authStatus.tooltip = "Celiador account — click to sign out";
      authStatus.command = "celiador.signOut";
    } else {
      authStatus.text = "$(account) Sign in";
      authStatus.tooltip = "Sign in to Celiador";
      authStatus.command = "celiador.signIn";
    }
    authStatus.show();
  };
  context.subscriptions.push(authStatus, auth.onDidChange(() => void updateAuthStatus()));
  void updateAuthStatus();
}

export function deactivate(): void {
  /* no-op */
}
