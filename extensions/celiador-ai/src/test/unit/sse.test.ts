import * as assert from "assert";

function parseSSELine(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function splitSSEBuffer(buffer: string): { lines: string[]; remaining: string } {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";
  return { lines, remaining };
}

describe("SSE Parser Unit Tests", () => {
  describe("parseSSELine", () => {
    it("should parse valid data events", () => {
      const event = parseSSELine('data: {"type":"test","value":123}');
      assert.ok(event);
      assert.strictEqual(event.type, "test");
      assert.strictEqual(event.value, 123);
    });

    it("should return null for non-data lines", () => {
      assert.strictEqual(parseSSELine(": comment"), null);
      assert.strictEqual(parseSSELine("event: ping"), null);
      assert.strictEqual(parseSSELine("id: 123"), null);
    });

    it("should return null for [DONE]", () => {
      assert.strictEqual(parseSSELine("data: [DONE]"), null);
    });

    it("should return null for empty data", () => {
      assert.strictEqual(parseSSELine("data: "), null);
      assert.strictEqual(parseSSELine("data:"), null);
    });

    it("should return null for invalid JSON", () => {
      assert.strictEqual(parseSSELine("data: {invalid json}"), null);
    });
  });

  describe("splitSSEBuffer", () => {
    it("should split complete lines", () => {
      const { lines, remaining } = splitSSEBuffer("line1\nline2\nline3");
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0], "line1");
      assert.strictEqual(lines[1], "line2");
      assert.strictEqual(remaining, "line3");
    });

    it("should handle trailing newline", () => {
      const { lines, remaining } = splitSSEBuffer("line1\nline2\n");
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(remaining, "");
    });

    it("should handle single incomplete line", () => {
      const { lines, remaining } = splitSSEBuffer("incomplete");
      assert.strictEqual(lines.length, 0);
      assert.strictEqual(remaining, "incomplete");
    });

    it("should handle empty buffer", () => {
      const { lines, remaining } = splitSSEBuffer("");
      assert.strictEqual(lines.length, 0);
      assert.strictEqual(remaining, "");
    });
  });
});
