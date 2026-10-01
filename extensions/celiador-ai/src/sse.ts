export interface SSEEvent {
  type: string;
  [key: string]: any;
}

export function parseSSELine(line: string): SSEEvent | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function splitSSEBuffer(buffer: string): { lines: string[]; remaining: string } {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";
  return { lines, remaining };
}
