import { Auth } from "./auth";
import { parseSSELine, splitSSEBuffer } from "./sse";

/**
 * SessionRelay bridges the Celiador editor chat panel with the daemon session API,
 * enabling the iOS app to watch and steer editor sessions.
 *
 * Lifecycle:
 * - createSession() when a turn starts → POST /api/sessions
 * - connectCommandsStream() to receive phone commands → GET /api/sessions/:id/commands
 * - postEvent() for each delta, tool, reply, done → POST /api/sessions/:id/events
 * - dispose() on deactivation or session end
 *
 * Mirrored from Celiador chat panel:
 * - Text deltas
 * - Tool calls (name, input)
 * - Tool results (name, ok/error)
 * - Final replies
 * - Done marker
 *
 * NOT mirrored (VS Code native chat uses different loop):
 * - VS Code chat panel state
 * - Language model provider messages
 */

export interface SessionEvent {
  type: "delta" | "tool" | "toolResult" | "reply" | "done";
  text?: string;
  name?: string;
  input?: any;
  ok?: boolean;
}

export interface PhoneCommand {
  type: "message" | "approve" | "reject" | "answer" | "cancel";
  text?: string;
}

export class SessionRelay {
  private sessionId: string | undefined;
  private commandsAbort: AbortController | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private disposed = false;

  constructor(
    private daemonUrl: string,
    private auth: Auth,
    private onCommand: (cmd: PhoneCommand) => void
  ) {}

  /**
   * Create a new session on the daemon.
   * Returns session ID or undefined if creation failed.
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
          origin: "editor",
          runner: "celiador-chat",
        }),
      });

      if (!res.ok) {
        console.error(`[SessionRelay] Failed to create session: ${res.status}`);
        return undefined;
      }

      const data = (await res.json()) as { id: string };
      this.sessionId = data.id;
      console.log(`[SessionRelay] Created session ${this.sessionId}`);

      // Start listening for commands from the phone
      void this.connectCommandsStream();

      return this.sessionId;
    } catch (err) {
      console.error(`[SessionRelay] Error creating session:`, err);
      return undefined;
    }
  }

  /**
   * Post an event to the current session.
   */
  async postEvent(event: SessionEvent): Promise<void> {
    if (!this.sessionId || this.disposed) return;

    const signedIn = await this.auth.isSignedIn();
    if (!signedIn) return;

    const bearer = await this.auth.getAccessToken();
    if (!bearer) return;

    try {
      // Map event to daemon format
      const daemonEvent = this.mapEventToDaemonFormat(event);
      if (!daemonEvent) return;

      const res = await fetch(`${this.daemonUrl}/api/sessions/${this.sessionId}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(daemonEvent),
      });

      if (!res.ok) {
        console.error(`[SessionRelay] Failed to post event: ${res.status}`);
      }
    } catch (err) {
      console.error(`[SessionRelay] Error posting event:`, err);
    }
  }

  /**
   * Map editor event format to daemon event format.
   * Based on daemon types.ts and iOS Events.swift expectations.
   */
  private mapEventToDaemonFormat(event: SessionEvent): any {
    switch (event.type) {
      case "delta":
        return {
          type: "delta",
          text: event.text || "",
        };

      case "tool":
        return {
          type: "tool",
          name: event.name || "",
          input: event.input || {},
        };

      case "toolResult":
        return {
          type: "toolResult",
          name: event.name || "",
          success: event.ok ?? true,
        };

      case "reply":
        return {
          type: "reply",
          text: event.text || "",
        };

      case "done":
        return {
          type: "done",
        };

      default:
        return null;
    }
  }

  /**
   * Connect to the commands stream to receive phone commands.
   * Reconnects automatically with exponential backoff on failure.
   */
  private async connectCommandsStream(): Promise<void> {
    if (!this.sessionId || this.disposed) return;

    // Cancel any existing connection
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
          // Token expired, refresh and retry
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

      // Reset reconnect delay on successful connection
      this.reconnectDelay = 1000;

      // Read SSE stream
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

      // Stream ended, reconnect
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
   * Handle a command received from the phone.
   */
  private handleCommand(data: any): void {
    if (!data || typeof data !== "object") return;

    const type = data.type as string;
    switch (type) {
      case "message":
        this.onCommand({ type: "message", text: data.text || "" });
        break;

      case "approve":
        this.onCommand({ type: "approve" });
        break;

      case "reject":
        this.onCommand({ type: "reject" });
        break;

      case "answer":
        this.onCommand({ type: "answer", text: data.text || "" });
        break;

      case "cancel":
        this.onCommand({ type: "cancel" });
        break;

      default:
        console.log(`[SessionRelay] Unknown command type: ${type}`);
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

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  /**
   * Clean shutdown: abort streams, clear timers, mark as disposed.
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

    this.sessionId = undefined;
  }
}
