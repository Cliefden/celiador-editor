// Session relay client for the editor.
//
// Makes an agent run OBSERVABLE and CONTROLLABLE from the companion phone. The
// editor stays the runner (the agent loop + tools run locally, on the real
// workspace); this just mirrors what the loop emits to the daemon's session log
// and receives commands (instruct / approve / reject / cancel) back over an SSE
// command channel. Everything here is best-effort — a relay failure must never
// break the local run.

import { randomUUID } from "node:crypto";

/** An event body published to the session log (the daemon assigns seq/at). */
export interface RelayEvent {
  kind: string;
  [key: string]: unknown;
}

/** Debounce window for coalescing high-frequency events (streamed deltas). */
const FLUSH_MS = 150;
/** Reconnect backoff for the command channel. */
const RECONNECT_MS = 1500;

/** Kinds that should reach the phone immediately rather than wait for a flush. */
const URGENT = new Set(["approval", "question", "state", "done", "error"]);

export class SessionRelay {
  private sessionId: string | undefined;
  private lastState: string | undefined;
  private buffer: RelayEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private commandAbort: AbortController | undefined;
  private readonly approvals = new Map<string, (ok: boolean) => void>();

  /** Set by the provider: a remote follow-up instruction arrived. */
  onInstruct?: (text: string) => void;
  /** Set by the provider: the run was cancelled from the phone. */
  onCancel?: () => void;

  constructor(private readonly getUrl: () => string, private readonly getToken: () => Promise<string | undefined>) {}

  /** True once a session exists (so events will actually be relayed). */
  get active(): boolean {
    return !!this.sessionId;
  }

  /** Lazily create the session (titled by the first prompt) and open its command channel. */
  async start(title: string): Promise<void> {
    if (this.sessionId) return;
    const token = await this.getToken();
    if (!token) return; // signed out → local-only, no relay
    try {
      const res = await fetch(`${this.getUrl()}/api/sessions`, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({ title, origin: "editor", runner: "editor" }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { session?: { id?: string } };
      this.sessionId = data.session?.id;
      this.lastState = undefined;
      if (this.sessionId) this.openCommands(this.sessionId);
    } catch {
      /* best-effort */
    }
  }

  /** Queue an event for the phone; urgent kinds flush immediately. */
  publish(event: RelayEvent): void {
    if (!this.sessionId) return;
    if (event.kind === "state") {
      if (event.state === this.lastState) return; // collapse repeats
      this.lastState = event.state as string;
    }
    this.buffer.push(event);
    if (URGENT.has(event.kind)) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS);
    }
  }

  /** A promise that resolves when the phone approves/rejects this request. */
  waitForApproval(requestId: string): Promise<boolean> {
    return new Promise((resolve) => this.approvals.set(requestId, resolve));
  }

  clearApproval(requestId: string): void {
    this.approvals.delete(requestId);
  }

  /** Fresh id for an approval/question round-trip. */
  newRequestId(): string {
    return randomUUID();
  }

  /** End the current session locally (next task starts a new one). */
  reset(): void {
    void this.flush();
    this.commandAbort?.abort();
    this.commandAbort = undefined;
    this.sessionId = undefined;
    this.lastState = undefined;
    this.approvals.clear();
  }

  dispose(): void {
    this.commandAbort?.abort();
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.sessionId || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const token = await this.getToken().catch(() => undefined);
    if (!token) return;
    try {
      await fetch(`${this.getUrl()}/api/sessions/${this.sessionId}/events`, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify(batch),
      });
    } catch {
      /* drop — best-effort */
    }
  }

  private openCommands(id: string): void {
    this.commandAbort?.abort();
    const ac = new AbortController();
    this.commandAbort = ac;
    void this.readCommands(id, ac);
  }

  private async readCommands(id: string, ac: AbortController): Promise<void> {
    while (!ac.signal.aborted && this.sessionId === id) {
      try {
        const token = await this.getToken();
        if (!token) return;
        const res = await fetch(`${this.getUrl()}/api/sessions/${id}/commands`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          await this.backoff(ac);
          continue;
        }
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
            if (!payload) continue;
            try {
              this.handleCommand(JSON.parse(payload));
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch {
        if (ac.signal.aborted) return;
      }
      await this.backoff(ac);
    }
  }

  private handleCommand(cmd: { kind?: string; text?: string; requestId?: string }): void {
    if (cmd.kind === "instruct" && typeof cmd.text === "string") {
      this.onInstruct?.(cmd.text);
    } else if (cmd.kind === "cancel") {
      this.onCancel?.();
    } else if ((cmd.kind === "approve" || cmd.kind === "reject") && cmd.requestId) {
      const resolve = this.approvals.get(cmd.requestId);
      if (resolve) {
        this.approvals.delete(cmd.requestId);
        resolve(cmd.kind === "approve");
      }
    }
    // "answer" has no editor-side question flow yet.
  }

  private backoff(ac: AbortController): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, RECONNECT_MS);
      ac.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
