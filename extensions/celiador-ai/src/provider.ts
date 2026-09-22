import * as vscode from "vscode";
import { Auth } from "./auth";

/**
 * Celiador as a language model provider.
 *
 * The editor used to own an agent loop, three file tools and a webview to
 * render them in. It no longer does: VS Code's own chat, agent mode, inline
 * edit, multi-file diff review and checkpoints all run on whatever model is
 * selected, so Celiador supplies the model and inherits the rest.
 *
 * Everything that decides what a request costs — model, token ceiling, effort,
 * caching — stays server-side in the daemon gateway. This file only
 * translates between VS Code's message shape and Anthropic's.
 */

export const VENDOR = "celiador";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Shown when the daemon can't be reached, so the picker is never empty. */
const FALLBACK_MODELS: vscode.LanguageModelChatInformation[] = [
  {
    id: "celiador-default",
    name: "Celiador",
    family: "celiador",
    version: "1",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
    capabilities: { toolCalling: true, imageInput: true },
  },
];

function config(): { url: string; token: string; provider: string; model: string } {
  const cfg = vscode.workspace.getConfiguration("celiador");
  return {
    url: (cfg.get<string>("daemonUrl") || "https://celiador.ai").replace(/\/+$/, ""),
    token: cfg.get<string>("token") || "",
    provider: cfg.get<string>("provider") || "daemon",
    model: cfg.get<string>("model") || "claude-opus-5",
  };
}

// ---- VS Code → Anthropic ----------------------------------------------------

/** A content block as Anthropic's Messages API expects it. */
type Block = Record<string, unknown>;

function toAnthropicBlocks(content: readonly unknown[]): Block[] {
  const blocks: Block[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value) blocks.push({ type: "text", text: part.value });
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      blocks.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input ?? {} });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      // Anthropic wants tool results as text; flatten whatever VS Code nested.
      const text = part.content
        .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : ""))
        .filter(Boolean)
        .join("\n");
      blocks.push({ type: "tool_result", tool_use_id: part.callId, content: text });
    } else if (part instanceof vscode.LanguageModelDataPart) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mimeType,
          data: Buffer.from(part.data).toString("base64"),
        },
      });
    }
  }
  return blocks;
}

function toAnthropicMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Block[] {
  const out: Block[] = [];
  for (const message of messages) {
    const blocks = toAnthropicBlocks(message.content);
    if (blocks.length === 0) continue; // Anthropic rejects empty content
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
    // Consecutive same-role messages are not allowed; fold them together.
    const last = out[out.length - 1];
    if (last && last.role === role) (last.content as Block[]).push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

function toAnthropicTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Block[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? { type: "object", properties: {} },
  }));
}

// ---- The provider -----------------------------------------------------------

export class CeliadorChatProvider implements vscode.LanguageModelChatProvider {
  constructor(
    private readonly auth: Auth,
    private readonly secrets: vscode.SecretStorage,
    /** Called after a billed response so the balance indicator can refresh. */
    private readonly onSpend?: () => void
  ) {}

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const { url, provider, model } = config();
    if (provider === "anthropic") {
      // BYOK: the daemon isn't in the loop, so advertise what the setting says.
      return [{ ...FALLBACK_MODELS[0], id: model, name: `${model} (your API key)` }];
    }
    try {
      const res = await fetch(`${url}/api/agent/models`, {
        headers: await this.headers(true),
        signal: abortSignal(token),
      });
      if (!res.ok) return FALLBACK_MODELS;
      const body = (await res.json()) as { models?: vscode.LanguageModelChatInformation[] };
      return body.models?.length ? body.models : FALLBACK_MODELS;
    } catch {
      // Offline, signed out, or self-hosted without the route — still usable.
      return FALLBACK_MODELS;
    }
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const { url, provider, model } = config();
    const daemonMode = provider !== "anthropic";

    const body: Record<string, unknown> = {
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(options.tools),
    };
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      body.tool_choice = { type: "any" };
    }
    if (!daemonMode) {
      // BYOK: unsupported escape hatch, so the client picks everything the
      // gateway would otherwise decide.
      Object.assign(body, {
        model,
        max_tokens: 32000,
        stream: true,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: vscode.workspace.getConfiguration("celiador").get("effort") || "high" },
      });
    }

    const endpoint = daemonMode ? `${url}/api/agent/messages` : ANTHROPIC_URL;
    let res = await fetch(endpoint, {
      method: "POST",
      headers: await this.headers(daemonMode),
      body: JSON.stringify(body),
      signal: abortSignal(token),
    });
    if (res.status === 401 && daemonMode && (await this.auth.tryRefresh())) {
      res = await fetch(endpoint, {
        method: "POST",
        headers: await this.headers(daemonMode),
        body: JSON.stringify(body),
        signal: abortSignal(token),
      });
    }
    if (!res.ok || !res.body) {
      const message = await describeFailure(res);
      // LanguageModelError has no quota or upgrade cause — only NoPermissions,
      // Blocked and NotFound — so this message is the entire affordance the
      // user gets. It has to say what to do about it.
      if (res.status === 402) throw vscode.LanguageModelError.NoPermissions(message);
      throw new Error(message);
    }

    await this.pump(res.body, progress, token);
    this.onSpend?.();
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const { url } = config();
    const messages =
      typeof text === "string"
        ? [{ role: "user", content: [{ type: "text", text }] }]
        : toAnthropicMessages([text]);
    if (messages.length === 0) return 0;
    try {
      const res = await fetch(`${url}/api/agent/count_tokens`, {
        method: "POST",
        headers: await this.headers(true),
        body: JSON.stringify({ messages }),
        signal: abortSignal(token),
      });
      if (res.ok) {
        const body = (await res.json()) as { input_tokens?: number };
        if (typeof body.input_tokens === "number") return body.input_tokens;
      }
    } catch {
      // fall through to the estimate
    }
    // Only ever a fallback: a wrong count mis-sizes the context window, so the
    // real tokenizer is the daemon's count_tokens proxy above.
    const raw = typeof text === "string" ? text : JSON.stringify(messages);
    return Math.ceil(raw.length / 4);
  }

  /** Read Anthropic's SSE stream and emit VS Code response parts. */
  private async pump(
    stream: ReadableStream<Uint8Array>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // Tool inputs stream as JSON fragments; accumulate per content-block index.
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();
    let buf = "";

    for (;;) {
      if (token.isCancellationRequested) {
        await reader.cancel().catch(() => undefined);
        return;
      }
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
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }

        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          pendingTools.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && ev.delta.text) {
            progress.report(new vscode.LanguageModelTextPart(ev.delta.text));
          } else if (ev.delta?.type === "input_json_delta") {
            const tool = pendingTools.get(ev.index);
            if (tool) tool.json += ev.delta.partial_json ?? "";
          }
        } else if (ev.type === "content_block_stop") {
          const tool = pendingTools.get(ev.index);
          if (tool) {
            pendingTools.delete(ev.index);
            let input: object = {};
            try {
              input = tool.json ? JSON.parse(tool.json) : {};
            } catch {
              // A truncated tool input is a failed call, not a crash — hand
              // back an empty object and let the agent see the bad result.
              input = {};
            }
            progress.report(new vscode.LanguageModelToolCallPart(tool.id, tool.name, input));
          }
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason === "refusal") {
          throw new Error("The model declined this request.");
        }
      }
    }
  }

  private async headers(daemonMode: boolean): Promise<Record<string, string>> {
    if (!daemonMode) {
      const cfg = vscode.workspace.getConfiguration("celiador");
      // Same resolution order the BYOK path always used: keychain, setting, env.
      const key =
        (await this.secrets.get("celiador.apiKey")) ||
        cfg.get<string>("apiKey") ||
        process.env.ANTHROPIC_API_KEY ||
        "";
      if (!key) {
        throw new Error(
          '`celiador.provider` is "anthropic" (bring-your-own-key, unsupported) but no key is set. ' +
            'Set it back to "daemon" and sign in, or run "Celiador: Set API Key".'
        );
      }
      return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
    }
    const { token } = config();
    const bearer = (await this.auth.isSignedIn()) ? await this.auth.getAccessToken() : token;
    if (!bearer) throw new Error('Sign in to use Celiador: run "Celiador: Sign In".');
    return { Authorization: `Bearer ${bearer}`, "content-type": "application/json" };
  }
}

function abortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/** The gateway reports quota and throttling as JSON `{error}` — show that. */
async function describeFailure(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === "string") detail = parsed.error;
    else if (typeof parsed?.error?.message === "string") detail = parsed.error.message;
  } catch {
    // not JSON — keep the raw body
  }
  if (res.status === 402) return `${detail} Run "Celiador: Manage Billing" to add credits or change plan.`;
  if (res.status === 429) return `Rate limited: ${detail}`;
  return `Celiador request failed (${res.status}): ${detail}`;
}
