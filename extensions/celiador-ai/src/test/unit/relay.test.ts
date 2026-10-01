import * as assert from "assert";
import { SessionRelay, SessionEventInput, SessionCommand } from "../../relay";

// Mock Auth class for testing
class MockAuth {
  private signedIn = true;
  private token = "mock-token";

  async isSignedIn(): Promise<boolean> {
    return this.signedIn;
  }

  async getAccessToken(): Promise<string> {
    return this.token;
  }

  setSignedIn(value: boolean): void {
    this.signedIn = value;
  }

  setToken(value: string): void {
    this.token = value;
  }
}

describe("SessionRelay Daemon Protocol", () => {
  describe("Event Mapping (Editor → Daemon)", () => {
    it("should map delta events to daemon format with kind", async () => {
      const mockAuth = new MockAuth();
      let postedEvents: any[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      // Capture postEvent calls
      (relay as any).postEvent = async (event: any) => {
        postedEvents.push(event);
      };

      await relay.handleEditorEvent({ type: "delta", text: "Hello world" });

      assert.strictEqual(postedEvents.length, 1);
      assert.strictEqual(postedEvents[0].kind, "delta");
      assert.strictEqual(postedEvents[0].text, "Hello world");

      relay.dispose();
    });

    it("should map tool events with callId", async () => {
      const mockAuth = new MockAuth();
      let postedEvents: any[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      (relay as any).postEvent = async (event: any) => {
        postedEvents.push(event);
      };

      await relay.handleEditorEvent({
        type: "tool",
        name: "read_file",
        input: { path: "test.ts" },
      });

      assert.strictEqual(postedEvents.length, 1);
      assert.strictEqual(postedEvents[0].kind, "tool");
      assert.strictEqual(postedEvents[0].name, "read_file");
      assert.ok(postedEvents[0].callId);
      assert.ok(postedEvents[0].callId.startsWith("call_"));
      assert.deepStrictEqual(postedEvents[0].input, { path: "test.ts" });

      relay.dispose();
    });

    it("should map toolResult events with callId and ok flag", async () => {
      const mockAuth = new MockAuth();
      let postedEvents: any[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      (relay as any).postEvent = async (event: any) => {
        postedEvents.push(event);
      };

      // First post tool to get callId
      await relay.handleEditorEvent({
        type: "tool",
        name: "read_file",
        input: {},
      });

      // Then post toolResult
      await relay.handleEditorEvent({
        type: "toolResult",
        name: "read_file",
        ok: true,
      });

      assert.strictEqual(postedEvents.length, 2);
      const toolResultEvent = postedEvents[1];
      assert.strictEqual(toolResultEvent.kind, "toolResult");
      assert.strictEqual(toolResultEvent.callId, postedEvents[0].callId);
      assert.strictEqual(toolResultEvent.ok, true);
      assert.strictEqual(toolResultEvent.success, undefined); // Daemon uses 'ok' not 'success'

      relay.dispose();
    });

    it("should map reply events to message with role assistant", async () => {
      const mockAuth = new MockAuth();
      let postedEvents: any[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      (relay as any).postEvent = async (event: any) => {
        postedEvents.push(event);
      };

      await relay.handleEditorEvent({
        type: "reply",
        text: "Task completed",
      });

      assert.strictEqual(postedEvents.length, 1);
      assert.strictEqual(postedEvents[0].kind, "message");
      assert.strictEqual(postedEvents[0].role, "assistant");
      assert.strictEqual(postedEvents[0].text, "Task completed");

      relay.dispose();
    });

    it("should map done events to state done + done event", async () => {
      const mockAuth = new MockAuth();
      let postedEvents: any[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      (relay as any).postEvent = async (event: any) => {
        postedEvents.push(event);
      };

      await relay.handleEditorEvent({ type: "done" });

      assert.strictEqual(postedEvents.length, 2);
      assert.strictEqual(postedEvents[0].kind, "state");
      assert.strictEqual(postedEvents[0].state, "done");
      assert.strictEqual(postedEvents[1].kind, "done");

      relay.dispose();
    });

    it("should map running event to state running", async () => {
      const mockAuth = new MockAuth();
      let postedEvents: any[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      (relay as any).postEvent = async (event: any) => {
        postedEvents.push(event);
      };

      await relay.handleEditorEvent({ type: "running", value: true });

      assert.strictEqual(postedEvents.length, 1);
      assert.strictEqual(postedEvents[0].kind, "state");
      assert.strictEqual(postedEvents[0].state, "running");

      relay.dispose();
    });
  });

  describe("Command Parsing (Daemon → Editor)", () => {
    it("should parse instruct commands with kind", () => {
      const mockAuth = new MockAuth();
      let receivedCommand: SessionCommand | undefined;

      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
        receivedCommand = cmd;
      });

      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ kind: "instruct", text: "Hello from phone" });

      assert.ok(receivedCommand);
      assert.strictEqual(receivedCommand.kind, "instruct");
      assert.strictEqual((receivedCommand as any).text, "Hello from phone");

      relay.dispose();
    });

    it("should parse approve commands with requestId", () => {
      const mockAuth = new MockAuth();
      let receivedCommand: SessionCommand | undefined;

      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
        receivedCommand = cmd;
      });

      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ kind: "approve", requestId: "req_123" });

      assert.ok(receivedCommand);
      assert.strictEqual(receivedCommand.kind, "approve");
      assert.strictEqual((receivedCommand as any).requestId, "req_123");

      relay.dispose();
    });

    it("should parse reject commands with requestId", () => {
      const mockAuth = new MockAuth();
      let receivedCommand: SessionCommand | undefined;

      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
        receivedCommand = cmd;
      });

      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ kind: "reject", requestId: "req_456" });

      assert.ok(receivedCommand);
      assert.strictEqual(receivedCommand.kind, "reject");
      assert.strictEqual((receivedCommand as any).requestId, "req_456");

      relay.dispose();
    });

    it("should parse answer commands with requestId and text", () => {
      const mockAuth = new MockAuth();
      let receivedCommand: SessionCommand | undefined;

      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
        receivedCommand = cmd;
      });

      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ kind: "answer", requestId: "req_789", text: "42" });

      assert.ok(receivedCommand);
      assert.strictEqual(receivedCommand.kind, "answer");
      assert.strictEqual((receivedCommand as any).requestId, "req_789");
      assert.strictEqual((receivedCommand as any).text, "42");

      relay.dispose();
    });

    it("should parse cancel commands", () => {
      const mockAuth = new MockAuth();
      let receivedCommand: SessionCommand | undefined;

      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
        receivedCommand = cmd;
      });

      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ kind: "cancel" });

      assert.ok(receivedCommand);
      assert.strictEqual(receivedCommand.kind, "cancel");

      relay.dispose();
    });

    it("should ignore commands without kind field", () => {
      const mockAuth = new MockAuth();
      let receivedCommand: SessionCommand | undefined;

      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
        receivedCommand = cmd;
      });

      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ type: "message" }); // Wrong field name

      assert.strictEqual(receivedCommand, undefined);

      relay.dispose();
    });
  });

  describe("Full Turn Sequence", () => {
    it("should post correct event sequence for a complete turn", async () => {
      const mockAuth = new MockAuth();
      const postedEvents: SessionEventInput[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      // Capture all postEvent calls
      (relay as any).postEvent = async (event: SessionEventInput) => {
        postedEvents.push(event);
      };

      // Simulate a complete turn
      await relay.postUserMessage("Read test.ts");
      await relay.handleEditorEvent({ type: "running", value: true });
      await relay.handleEditorEvent({ type: "delta", text: "I'll " });
      await relay.handleEditorEvent({ type: "delta", text: "read that file." });
      await relay.handleEditorEvent({
        type: "tool",
        name: "read_file",
        input: { path: "test.ts" },
      });
      await relay.handleEditorEvent({
        type: "toolResult",
        name: "read_file",
        ok: true,
      });
      await relay.handleEditorEvent({
        type: "reply",
        text: "Here's the content.",
      });
      await relay.handleEditorEvent({ type: "done" });

      // Verify exact sequence
      assert.strictEqual(postedEvents.length, 9);

      // User message
      assert.strictEqual(postedEvents[0].kind, "message");
      assert.strictEqual((postedEvents[0] as any).role, "user");
      assert.strictEqual((postedEvents[0] as any).text, "Read test.ts");

      // State running
      assert.strictEqual(postedEvents[1].kind, "state");
      assert.strictEqual((postedEvents[1] as any).state, "running");

      // Delta 1
      assert.strictEqual(postedEvents[2].kind, "delta");
      assert.strictEqual((postedEvents[2] as any).text, "I'll ");

      // Delta 2
      assert.strictEqual(postedEvents[3].kind, "delta");
      assert.strictEqual((postedEvents[3] as any).text, "read that file.");

      // Tool call
      assert.strictEqual(postedEvents[4].kind, "tool");
      assert.ok((postedEvents[4] as any).callId);
      assert.strictEqual((postedEvents[4] as any).name, "read_file");
      assert.deepStrictEqual((postedEvents[4] as any).input, { path: "test.ts" });

      // Tool result
      assert.strictEqual(postedEvents[5].kind, "toolResult");
      assert.strictEqual((postedEvents[5] as any).callId, (postedEvents[4] as any).callId);
      assert.strictEqual((postedEvents[5] as any).ok, true);

      // Assistant message
      assert.strictEqual(postedEvents[6].kind, "message");
      assert.strictEqual((postedEvents[6] as any).role, "assistant");
      assert.strictEqual((postedEvents[6] as any).text, "Here's the content.");

      // State done
      assert.strictEqual(postedEvents[7].kind, "state");
      assert.strictEqual((postedEvents[7] as any).state, "done");

      // Done event
      assert.strictEqual(postedEvents[8].kind, "done");

      relay.dispose();
    });
  });

  describe("Approval Workflow", () => {
    it("should emit approval event with requestId and transition to awaiting state", async () => {
      const mockAuth = new MockAuth();
      const postedEvents: SessionEventInput[] = [];
      const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

      (relay as any).postEvent = async (event: SessionEventInput) => {
        postedEvents.push(event);
      };

      // Start approval request (don't await - would block)
      const approvalPromise = relay.requestApproval("src/test.ts", "preview content");

      // Let the approval event post
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have posted state awaiting and approval event
      assert.ok(postedEvents.some((e) => e.kind === "state" && (e as any).state === "awaiting"));
      const approvalEvent = postedEvents.find((e) => e.kind === "approval");
      assert.ok(approvalEvent);
      assert.strictEqual((approvalEvent as any).approvalKind, "write_file");
      assert.strictEqual((approvalEvent as any).path, "src/test.ts");
      assert.strictEqual((approvalEvent as any).preview, "preview content");
      assert.ok((approvalEvent as any).requestId);

      // Simulate phone approval
      const handleCommand = (relay as any).handleCommand.bind(relay);
      handleCommand({ kind: "approve", requestId: (approvalEvent as any).requestId });

      const approved = await approvalPromise;
      assert.strictEqual(approved, true);

      relay.dispose();
    });
  });
});
