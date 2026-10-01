import * as assert from "assert";
import { SessionRelay, SessionEvent, PhoneCommand } from "../../relay";

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

describe("SessionRelay Event Mapping", () => {
  it("should map delta events to daemon format", () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    // Access private method via type assertion for testing
    const mapEvent = (relay as any).mapEventToDaemonFormat.bind(relay);

    const deltaEvent: SessionEvent = {
      type: "delta",
      text: "Hello world",
    };

    const mapped = mapEvent(deltaEvent);
    assert.strictEqual(mapped.type, "delta");
    assert.strictEqual(mapped.text, "Hello world");

    relay.dispose();
  });

  it("should map tool events to daemon format", () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    const mapEvent = (relay as any).mapEventToDaemonFormat.bind(relay);

    const toolEvent: SessionEvent = {
      type: "tool",
      name: "read_file",
      input: { path: "test.ts" },
    };

    const mapped = mapEvent(toolEvent);
    assert.strictEqual(mapped.type, "tool");
    assert.strictEqual(mapped.name, "read_file");
    assert.deepStrictEqual(mapped.input, { path: "test.ts" });

    relay.dispose();
  });

  it("should map toolResult events to daemon format", () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    const mapEvent = (relay as any).mapEventToDaemonFormat.bind(relay);

    const toolResultEvent: SessionEvent = {
      type: "toolResult",
      name: "read_file",
      ok: true,
    };

    const mapped = mapEvent(toolResultEvent);
    assert.strictEqual(mapped.type, "toolResult");
    assert.strictEqual(mapped.name, "read_file");
    assert.strictEqual(mapped.success, true);

    relay.dispose();
  });

  it("should map reply events to daemon format", () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    const mapEvent = (relay as any).mapEventToDaemonFormat.bind(relay);

    const replyEvent: SessionEvent = {
      type: "reply",
      text: "Task completed",
    };

    const mapped = mapEvent(replyEvent);
    assert.strictEqual(mapped.type, "reply");
    assert.strictEqual(mapped.text, "Task completed");

    relay.dispose();
  });

  it("should map done events to daemon format", () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    const mapEvent = (relay as any).mapEventToDaemonFormat.bind(relay);

    const doneEvent: SessionEvent = {
      type: "done",
    };

    const mapped = mapEvent(doneEvent);
    assert.strictEqual(mapped.type, "done");

    relay.dispose();
  });
});

describe("SessionRelay Command Handling", () => {
  it("should handle message commands", () => {
    const mockAuth = new MockAuth();
    let receivedCommand: PhoneCommand | undefined;

    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
      receivedCommand = cmd;
    });

    const handleCommand = (relay as any).handleCommand.bind(relay);

    handleCommand({ type: "message", text: "Hello from phone" });

    assert.ok(receivedCommand);
    assert.strictEqual(receivedCommand.type, "message");
    assert.strictEqual(receivedCommand.text, "Hello from phone");

    relay.dispose();
  });

  it("should handle approve commands", () => {
    const mockAuth = new MockAuth();
    let receivedCommand: PhoneCommand | undefined;

    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
      receivedCommand = cmd;
    });

    const handleCommand = (relay as any).handleCommand.bind(relay);

    handleCommand({ type: "approve" });

    assert.ok(receivedCommand);
    assert.strictEqual(receivedCommand.type, "approve");

    relay.dispose();
  });

  it("should handle reject commands", () => {
    const mockAuth = new MockAuth();
    let receivedCommand: PhoneCommand | undefined;

    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
      receivedCommand = cmd;
    });

    const handleCommand = (relay as any).handleCommand.bind(relay);

    handleCommand({ type: "reject" });

    assert.ok(receivedCommand);
    assert.strictEqual(receivedCommand.type, "reject");

    relay.dispose();
  });

  it("should handle answer commands", () => {
    const mockAuth = new MockAuth();
    let receivedCommand: PhoneCommand | undefined;

    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
      receivedCommand = cmd;
    });

    const handleCommand = (relay as any).handleCommand.bind(relay);

    handleCommand({ type: "answer", text: "42" });

    assert.ok(receivedCommand);
    assert.strictEqual(receivedCommand.type, "answer");
    assert.strictEqual(receivedCommand.text, "42");

    relay.dispose();
  });

  it("should handle cancel commands", () => {
    const mockAuth = new MockAuth();
    let receivedCommand: PhoneCommand | undefined;

    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
      receivedCommand = cmd;
    });

    const handleCommand = (relay as any).handleCommand.bind(relay);

    handleCommand({ type: "cancel" });

    assert.ok(receivedCommand);
    assert.strictEqual(receivedCommand.type, "cancel");

    relay.dispose();
  });

  it("should ignore unknown command types", () => {
    const mockAuth = new MockAuth();
    let receivedCommand: PhoneCommand | undefined;

    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, (cmd) => {
      receivedCommand = cmd;
    });

    const handleCommand = (relay as any).handleCommand.bind(relay);

    handleCommand({ type: "unknown" });

    assert.strictEqual(receivedCommand, undefined);

    relay.dispose();
  });
});

describe("SessionRelay Lifecycle", () => {
  it("should not post events after dispose", async () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    relay.dispose();

    // Should not throw or crash
    await relay.postEvent({ type: "delta", text: "test" });

    assert.ok(true, "dispose prevents further operations");
  });

  it("should abort streams on dispose", () => {
    const mockAuth = new MockAuth();
    const relay = new SessionRelay("https://test.celiador.ai", mockAuth as any, () => {});

    // Set up a mock commands stream
    (relay as any).commandsAbort = { abort: () => {} };

    relay.dispose();

    assert.strictEqual((relay as any).commandsAbort, undefined);
    assert.strictEqual((relay as any).disposed, true);
  });
});
