import { Auth } from "./auth";
import { parseSSELine, splitSSEBuffer } from "./sse";

/**
 * SessionRelay bridges the Celiador editor chat panel with the daemon session API.
 * Protocol matches Cliefden/daemon src/sessions/types.ts exactly.
 */

// Daemon protocol types (from Cliefden/daemon src/sessions/types.ts)
export type SessionOrigin = "editor" | "phone";
export type SessionRunner = "editor" | "server";
export type SessionState = "idle" | "running" | "awaiting" | "done" | "error" | "cancelled";

export type SessionEventInput =
  | { kind: "activity"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; callId: string; name: string; input: unknown }
  | { kind: "toolResult"; callId: string; ok: boolean }
  | { kind: "approval"; requestId: string; approvalKind: "write_file"; path: string; preview?: string }
  | { kind: "question"; requestId: string; prompt: string; choices?: string[] }
  | { kind: "diff"; path: string; patch: string }
  | { kind: "state"; state: SessionState }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type SessionCommand =
  | { kind: "instruct"; text: string }
  | { kind: "approve"; requestId: string }
  | { kind: "reject"; requestId: string }
  | { kind: "answer"; requestId: string; text: string }
  | { kind: "cancel" };

// Editor-internal event types (simplified subset for emit calls)
export interface EditorEvent {
  type: "delta" | "tool" | "toolResult" | "reply" | "running" | "done";
  text?: string;
  name?: string;
  input?: any;
  ok?: boolean;
  value?: boolean;
}

export interface ApprovalRequest {
  requestId: string;
  path: string;
  resolve: (approved: boolean) => void;
}

export class SessionRelay {
  private sessionId: string | undefined;
  private commandsAbort: AbortController | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private disposed = false;
  private toolCallIdMap = new Map<string, string>(); // toolName -> callId
  private pendingApprovals = new Map<string, ApprovalRequest>(); // requestId -> request
  private nextRequestId = 1;
  private eventBatch: SessionEventInput[] = [];
  private batchTimer: NodeJS.Timeout | undefined;
  private batchDelayMs = 100;

  constructor(
    private daemonUrl: string,
    private auth: Auth,
    private onCommand: (cmd: SessionCommand) => void
  ) {}

  /**
   * Create a new session on the daemon.
   */
  async createSession(title: string): Promise<string | undefined> {
    if (this.disposed) return undefined;

    const signedIn = await this.auth.isSignedIn();
    if (!signedIn) return undefined;

    const bearer = await this.auth.getAccessToken();
    if (!bearer) return undefined;

    try {
      const res = await fetch(`${this.daemonUrl}/api/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          origin: "editor" as SessionOrigin,
          runner: "editor" as SessionRunner,
        }),
      });

      if (!res.ok) {
        console.error(`[SessionRelay] Failed to create session: ${res.status}`);
        return undefined;
      }

      const data = (await res.json()) as { session: { id: string } };
      this.sessionId = data.session.id;
      console.log(`[SessionRelay] Created session ${this.sessionId}`);

      void this.connectCommandsStream();

      return this.sessionId;
    } catch (err) {
      console.error(`[SessionRelay] Error creating session:`, err);
      return undefined;
    }
  }

  /**
   * Post a user message at turn start.
   */
  async postUserMessage(text: string): Promise<void> {
    await this.postEvent({
      kind: "message",
      role: "user",
      text,
    });
  }

  /**
   * Post state change.
   */
  async postState(state: SessionState): Promise<void> {
    await this.postEvent({ kind: "state", state });
  }

  /**
   * Post an event to the current session.
   * Accepts single event or array of events.
   */
  async postEvent(event: SessionEventInput | SessionEventInput[]): Promise<void> {
    if (!this.sessionId || this.disposed) return;

    const signedIn = await this.auth.isSignedIn();
    if (!signedIn) return;

    const bearer = await this.auth.getAccessToken();
    if (!bearer) return;

    try {
      const res = await fetch(`${this.daemonUrl}/api/sessions/${this.sessionId}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[SessionRelay] Failed to post event: ${res.status} ${text}`);
      }
    } catch (err) {
      console.error(`[SessionRelay] Error posting event:`, err);
    }
  }

  /**
   * Batch an event for later posting.
   * Deltas are batched; other events flush immediately.
   */
  private async batchEvent(event: SessionEventInput): Promise<void> {
    if (event.kind === "delta") {
      this.eventBatch.push(event);
      
      // Schedule flush if not already scheduled
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.flushEventBatch();
        }, this.batchDelayMs);
      }
    } else {
      // Flush any pending deltas first
      this.flushEventBatch();
      // Then post this event immediately
      await this.postEvent(event);
    }
  }

  /**
   * Flush batched events.
   */
  private flushEventBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    if (this.eventBatch.length === 0) return;

    const batch = this.eventBatch.slice();
    this.eventBatch = [];

    if (batch.length === 1) {
      void this.postEvent(batch[0]);
    } else {
      void this.postEvent(batch);
    }
  }

  /**
   * Handle an editor event and map it to daemon protocol.
   */
  async handleEditorEvent(event: EditorEvent): Promise<void> {
    switch (event.type) {
      case "delta":
        // Batch deltas for efficient posting
        await this.batchEvent({
          kind: "delta",
          text: event.text || "",
        });
        break;

      case "tool": {
        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        if (event.name) {
          this.toolCallIdMap.set(event.name, callId);
        }
        await this.postEvent({
          kind: "tool",
          callId,
          name: event.name || "",
          input: event.input || {},
        });
        break;
      }

      case "toolResult": {
        const callId = event.name ? this.toolCallIdMap.get(event.name) : undefined;
        if (callId) {
          await this.postEvent({
            kind: "toolResult",
            callId,
            ok: event.ok ?? true,
          });
          if (event.name) {
            this.toolCallIdMap.delete(event.name);
          }
        }
        break;
      }

      case "reply":
        await this.postEvent({
          kind: "message",
          role: "assistant",
          text: event.text || "",
        });
        break;

      case "done":
        await this.postState("done");
        await this.postEvent({ kind: "done" });
        break;

      case "running":
        if (event.value) {
          await this.postState("running");
        }
        break;
    }
  }

  /**
   * Request approval for a file write.
   * Returns a promise that resolves when approved/rejected.
   */
  async requestApproval(path: string, preview?: string): Promise<boolean> {
    const requestId = `req_${this.nextRequestId++}`;

    const promise = new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(requestId, { requestId, path, resolve });
    });

    await this.postState("awaiting");
    await this.postEvent({
      kind: "approval",
      requestId,
      approvalKind: "write_file",
      path,
      preview,
    });

    const approved = await promise;
    this.pendingApprovals.delete(requestId);
    await this.postState("running");

    return approved;
  }

  /**
   * Resolve a pending approval request.
   */
  private resolveApproval(requestId: string, approved: boolean): void {
    const request = this.pendingApprovals.get(requestId);
    if (request) {
      request.resolve(approved);
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Connect to the commands stream.
   */
  private async connectCommandsStream(): Promise<void> {
    if (!this.sessionId || this.disposed) return;

    this.commandsAbort?.abort();
    this.commandsAbort = new AbortController();

    const signedIn = await this.auth.isSignedIn();
    if (!signedIn) {
      this.scheduleReconnect();
      return;
    }

    const bearer = await this.auth.getAccessToken();
    if (!bearer) {
      this.scheduleReconnect();
      return;
    }

    try {
      console.log(`[SessionRelay] Connecting to commands stream for session ${this.sessionId}`);

      const res = await fetch(`${this.daemonUrl}/api/sessions/${this.sessionId}/commands`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: this.commandsAbort.signal,
      });

      if (!res.ok) {
        console.error(`[SessionRelay] Commands stream failed: ${res.status}`);
        if (res.status === 401) {
          console.log(`[SessionRelay] Token expired, reconnecting...`);
        }
        this.scheduleReconnect();
        return;
      }

      if (!res.body) {
        console.error(`[SessionRelay] Commands stream has no body`);
        this.scheduleReconnect();
        return;
      }

      this.reconnectDelay = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (!this.disposed && !this.commandsAbort.signal.aborted) {
          const readResult = await reader.read();
          if (readResult.done) break;

          buffer += decoder.decode(readResult.value, { stream: true });
          const splitResult = splitSSEBuffer(buffer);
          buffer = splitResult.remaining;

          for (const line of splitResult.lines) {
            const data = parseSSELine(line);
            if (data) {
              this.handleCommand(data);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!this.disposed) {
        console.log(`[SessionRelay] Commands stream ended, reconnecting...`);
        this.scheduleReconnect();
      }
    } catch (err: any) {
      if (err.name === "AbortError" || this.disposed) return;
      console.error(`[SessionRelay] Commands stream error:`, err);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle a command from the daemon.
   */
  private handleCommand(data: any): void {
    if (!data || typeof data !== "object" || !data.kind) return;

    const cmd = data as SessionCommand;

    switch (cmd.kind) {
      case "instruct":
        this.onCommand(cmd);
        break;

      case "approve":
        this.resolveApproval(cmd.requestId, true);
        this.onCommand(cmd);
        break;

      case "reject":
        this.resolveApproval(cmd.requestId, false);
        this.onCommand(cmd);
        break;

      case "answer":
        this.onCommand(cmd);
        break;

      case "cancel":
        this.onCommand(cmd);
        break;

      default:
        console.log(`[SessionRelay] Unknown command kind:`, cmd);
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;

    console.log(`[SessionRelay] Reconnecting in ${this.reconnectDelay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectCommandsStream();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  /**
   * Clean shutdown.
   */
  dispose(): void {
    if (this.disposed) return;

    console.log(`[SessionRelay] Disposing session ${this.sessionId}`);
    this.disposed = true;

    this.commandsAbort?.abort();
    this.commandsAbort = undefined;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    // Flush any pending event batch
    this.flushEventBatch();

    // Reject all pending approvals
    for (const request of this.pendingApprovals.values()) {
      request.resolve(false);
    }
    this.pendingApprovals.clear();

    this.sessionId = undefined;
  }
}
