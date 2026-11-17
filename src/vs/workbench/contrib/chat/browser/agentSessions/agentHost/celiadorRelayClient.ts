/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';

/**
 * Celiador: HTTP client for the daemon's agent-session relay. Makes a local agent
 * run OBSERVABLE and CONTROLLABLE from the companion phone — the editor stays the
 * runner (the Claude agent + tools run locally on the real workspace); this mirrors
 * what the session emits to the daemon's session log and receives commands
 * (instruct / approve / reject / answer / cancel) back over an SSE command channel.
 *
 * Everything here is best-effort: a relay failure must never break the local run.
 * Ported from the `celiador-ai` extension's `relay.ts` (which drove the retired
 * extension agent loop) into the workbench so it can bridge the native agent host.
 */

/** An event body published to the session log (the daemon assigns seq/at). */
export interface IRelayEvent {
	readonly kind: string;
	readonly [key: string]: unknown;
}

/** A command received from a watcher (phone) over the command channel. */
export interface IRelayCommand {
	readonly kind?: string;
	readonly text?: string;
	readonly requestId?: string;
	/** fs.* / git.diff: the workspace-relative path to operate on. */
	readonly path?: string;
	/** fs.write: the new file contents. */
	readonly content?: string;
	/** git.commit: the commit message. */
	readonly message?: string;
	/** git.commit / git.revert: the workspace-relative paths to operate on. */
	readonly paths?: string[];
	/** git.pr: the pull request title. */
	readonly title?: string;
	/** git.pr: the pull request body. */
	readonly body?: string;
	/** git.pr: the base branch (defaults to the repository's default branch). */
	readonly base?: string;
	/** git.merge: how GitHub should merge the pull request (defaults to a merge commit). */
	readonly method?: 'merge' | 'squash' | 'rebase';
	/** git.merge: the branch whose pull request to merge (the worktree's HEAD when unset). */
	readonly head?: string;
}

/** The kinds of filesystem command the phone can round-trip to this runner. */
export type RelayFsKind = 'fs.list' | 'fs.read' | 'fs.write';

/** The kinds of run-review (git) command the phone can round-trip to this runner. */
export type RelayGitKind = 'git.status' | 'git.diff' | 'git.commit' | 'git.revert' | 'git.push' | 'git.pr' | 'git.merge';

/** The per-kind arguments of a relayed git command (see {@link IRelayCommand}). */
export interface IRelayGitArgs {
	readonly path?: string;
	readonly message?: string;
	readonly paths?: string[];
	readonly title?: string;
	readonly body?: string;
	readonly base?: string;
	readonly method?: 'merge' | 'squash' | 'rebase';
	readonly head?: string;
}

/** The small, safe slice of a tool call's input the relay publishes with a `tool` event. */
export interface IRelayToolInput {
	readonly path?: string;
	readonly command?: string;
	readonly pattern?: string;
}

const MAX_TOOL_COMMAND_CHARS = 200;

/**
 * Celiador: what a `tool` event may say about its input — `{ path }` for
 * read/edit/write-style tools (relative to `root` when inside it), `{ command }`
 * for shell tools (truncated), `{ pattern }` for search tools. Never file
 * contents or any other parameter. `toolInput` is the agent host's JSON string.
 */
export function summarizeRelayToolInput(toolName: string, toolInput: string | undefined, root: string | undefined): IRelayToolInput {
	if (!toolInput) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(toolInput);
	} catch {
		parsed = undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		// The Claude host hands shell and search tools their bare command / pattern
		// rather than JSON (getClaudeToolInputString).
		const text = toolInput.trim();
		if (text && /bash|shell|terminal|run|exec|command/i.test(toolName)) {
			return { command: text.length > MAX_TOOL_COMMAND_CHARS ? `${text.slice(0, MAX_TOOL_COMMAND_CHARS - 1)}…` : text };
		}
		if (text && /grep|glob|search|find/i.test(toolName)) {
			return { pattern: text.slice(0, MAX_TOOL_COMMAND_CHARS) };
		}
		return {};
	}
	const input = parsed as Record<string, unknown>;
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = input[key];
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
		}
		return undefined;
	};
	const command = pick('command', 'cmd');
	if (command && (/bash|shell|terminal|run|exec|command/i.test(toolName) || !pick('file_path', 'path', 'notebook_path', 'filePath'))) {
		return { command: command.length > MAX_TOOL_COMMAND_CHARS ? `${command.slice(0, MAX_TOOL_COMMAND_CHARS - 1)}…` : command };
	}
	const pattern = pick('pattern', 'query', 'glob');
	if (pattern && /grep|glob|search|find/i.test(toolName)) {
		return { pattern: pattern.slice(0, MAX_TOOL_COMMAND_CHARS) };
	}
	const path = pick('file_path', 'path', 'notebook_path', 'filePath');
	if (path) {
		const base = root?.replace(/[\\/]+$/, '');
		const relative = base && (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) ? path.slice(base.length + 1) : path;
		return { path: relative.slice(0, 1024) };
	}
	return pattern ? { pattern: pattern.slice(0, MAX_TOOL_COMMAND_CHARS) } : {};
}

/** Debounce window for coalescing high-frequency events (streamed deltas). */
const FLUSH_MS = 150;
/**
 * Command-channel reconnect backoff: exponential from the first delay up to the
 * cap, with jitter so every editor doesn't reconnect at once after a daemon
 * restart. The first retry stays well inside the daemon's runner grace period
 * (10 s), so a network blip doesn't end the run on the phone.
 */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * The daemon pings the command channel every 15 s. A channel silent for this
 * long is half-open (sleep, a NAT or proxy dropped it): drop it and reconnect
 * rather than silently miss phone commands.
 */
const COMMAND_IDLE_MS = 45_000;
/** Kinds that should reach the phone immediately rather than wait for a flush. */
const URGENT = new Set(['approval', 'question', 'state', 'done', 'error', 'fs.result']);
/** Delivery attempts per batch before it's dropped (relay is best-effort). */
const MAX_ATTEMPTS = 3;
/** Events buffered before the relay session exists (start() is async — a fast
 * run streams deltas before the create round-trip finishes; don't drop them). */
const MAX_PRESTART_BUFFER = 500;
/** How long a quiet client waits before re-claiming a mirror another window held (that window may be gone). */
const MIRROR_RETRY_MS = 60_000;

export interface ICeliadorRelayClientOptions {
	/** Resolve the daemon base URL (no trailing slash), e.g. `https://celiador.ai`. */
	readonly getUrl: () => string;
	/** Resolve the current bearer token, or undefined when signed out (→ local-only). */
	readonly getToken: () => Promise<string | undefined>;
	/** Best-effort logger for dropped batches / transient failures. */
	readonly log?: (message: string) => void;
	/** A remote follow-up instruction arrived from the phone. */
	readonly onInstruct?: (text: string) => void;
	/** An answer to a pending question arrived from the phone (carries the request id). */
	readonly onAnswer?: (requestId: string, text: string) => void;
	/** The run was cancelled from the phone. */
	readonly onCancel?: () => void;
	/** The phone approved (true) or rejected (false) a pending request. */
	readonly onApprovalDecision?: (requestId: string, approved: boolean) => void;
	/**
	 * The phone requested a workspace file operation (browse / read / edit). The
	 * handler performs it and replies by publishing an `fs.result` event carrying
	 * the same `requestId`.
	 */
	readonly onFsCommand?: (kind: RelayFsKind, requestId: string, path: string, content: string | undefined) => void;
	/**
	 * The phone requested a run-review git operation (status / diff / commit /
	 * revert). The handler performs it and replies by publishing an `fs.result`
	 * event carrying the same `requestId`.
	 */
	readonly onGitCommand?: (kind: RelayGitKind, requestId: string, args: IRelayGitArgs) => void;
	/** The `fetch` to use; tests pass a fake. Defaults to the global one. */
	readonly fetch?: typeof fetch;
	/** A number in [0, 1) for the reconnect jitter; tests pass a fixed one. Defaults to `Math.random`. */
	readonly random?: () => number;
}

/**
 * Celiador: how long to wait before the `attempt`-th reconnect in a row (from 0):
 * exponential up to {@link RECONNECT_MAX_MS}, jittered into the upper half of
 * that window so retries spread out but never collapse to nothing.
 */
export function relayReconnectDelay(attempt: number, random: number): number {
	const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** Math.min(attempt, 10));
	return Math.round(ceiling / 2 + random * ceiling / 2);
}

export class CeliadorRelayClient extends Disposable {
	private _sessionId: string | undefined;
	private _lastState: string | undefined;
	private _buffer: IRelayEvent[] = [];
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Flushes run strictly one after another: the daemon assigns `seq` in arrival
	 * order, so two concurrent POSTs (timer + urgent) could land a terminal
	 * `state` before the last deltas.
	 */
	private _flushChain: Promise<void> = Promise.resolve();
	private _commandAbort: AbortController | undefined;
	private _disposed = false;
	/**
	 * Another window (an editor window or the Agents window) already mirrors this
	 * agent session to the daemon: this client stays quiet so the phone gets one
	 * copy. Cleared when a later claim succeeds (that window went away).
	 */
	private _mirroredElsewhere = false;
	private _lastClaimAt = 0;
	/** What {@link start} was last called with, to create the session again if the daemon loses it. */
	private _startArgs: { readonly title: string; readonly taskId?: string; readonly mirrorKey?: string } | undefined;
	/** The last `state` event published, re-sent to a session created again. */
	private _lastStateEvent: IRelayEvent | undefined;
	/** Stops a pending re-create (see {@link _sessionLost}) on reset or dispose. */
	private _recreateAbort: AbortController | undefined;

	constructor(private readonly _options: ICeliadorRelayClientOptions) {
		super();
	}

	private _fetch(input: string, init?: RequestInit): Promise<Response> {
		return (this._options.fetch ?? fetch)(input, init);
	}

	/** True once a session exists (so events will actually be relayed). */
	get active(): boolean {
		return !!this._sessionId;
	}

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/** True while another window holds this agent session's mirror (see {@link _mirroredElsewhere}). */
	get mirroredElsewhere(): boolean {
		return this._mirroredElsewhere;
	}

	/**
	 * Lazily create the session (titled by the first prompt) and open its command
	 * channel. `mirrorKey` identifies the agent session across windows; the daemon
	 * answers 409 when another window already mirrors it.
	 */
	async start(title: string, taskId?: string, mirrorKey?: string): Promise<void> {
		if (this._sessionId || this._disposed) {
			return;
		}
		this._startArgs = { title, taskId, mirrorKey };
		if (this._mirroredElsewhere && Date.now() - this._lastClaimAt < MIRROR_RETRY_MS) {
			return;
		}
		const token = await this._options.getToken();
		if (!token) {
			return; // signed out → local-only, no relay
		}
		try {
			this._lastClaimAt = Date.now();
			const res = await this._fetch(`${this._options.getUrl()}/api/sessions`, {
				method: 'POST',
				headers: this._headers(token),
				body: JSON.stringify({ title, origin: 'editor', runner: 'editor', ...(taskId ? { taskId } : {}), ...(mirrorKey ? { mirrorKey } : {}) }), // Celiador: taskId links an agent task's run
			});
			if (res.status === 409) {
				this._mirroredElsewhere = true;
				this._buffer = [];
				this._options.log?.('another window already mirrors this session; staying quiet');
				return;
			}
			if (!res.ok) {
				return;
			}
			this._mirroredElsewhere = false;
			const data = await res.json() as { session?: { id?: string } };
			this._sessionId = data.session?.id;
			if (this._sessionId) {
				this._openCommands(this._sessionId);
				// Deliver anything published while the session was being created.
				void this._flush();
			}
		} catch {
			/* best-effort */
		}
	}

	/** Queue an event for the phone; urgent kinds flush immediately. Events
	 * published before the session exists are buffered and delivered by start(). */
	publish(event: IRelayEvent): void {
		if (this._disposed || this._mirroredElsewhere) {
			return;
		}
		if (event.kind === 'state') {
			if (event.state === this._lastState) {
				return; // collapse repeats
			}
			this._lastState = event.state as string;
			this._lastStateEvent = event;
		}
		this._buffer.push(event);
		if (this._buffer.length > MAX_PRESTART_BUFFER) {
			this._buffer.splice(0, this._buffer.length - MAX_PRESTART_BUFFER);
		}
		if (!this._sessionId) {
			return; // buffered — start() flushes once the session exists
		}
		if (URGENT.has(event.kind)) {
			void this._flush();
		} else if (!this._flushTimer) {
			this._flushTimer = setTimeout(() => void this._flush(), FLUSH_MS);
		}
	}

	/** Fresh id for an approval/question round-trip. */
	newRequestId(): string {
		return generateUuid();
	}

	/** End the current session locally (next task starts a new one). */
	reset(): void {
		void this._flush(); // captures the current sessionId synchronously before it's cleared
		this._commandAbort?.abort();
		this._commandAbort = undefined;
		this._recreateAbort?.abort();
		this._recreateAbort = undefined;
		this._sessionId = undefined;
		this._lastState = undefined;
		this._lastStateEvent = undefined;
	}

	override dispose(): void {
		// Drain buffered events (e.g. the final state/done) before going inert, so the
		// phone isn't left showing a run as still in progress.
		void this._flush();
		this._disposed = true;
		this._commandAbort?.abort();
		this._recreateAbort?.abort();
		super.dispose();
	}

	private _headers(token: string): Record<string, string> {
		return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
	}

	/**
	 * Take the buffered events (synchronously, together with the session they
	 * belong to) and queue their delivery behind any in-flight flush.
	 */
	private _flush(): Promise<void> {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		const sessionId = this._sessionId;
		if (!sessionId || this._buffer.length === 0) {
			return this._flushChain;
		}
		const batch = this._buffer;
		this._buffer = [];
		this._flushChain = this._flushChain.then(() => this._deliver(sessionId, batch));
		return this._flushChain;
	}

	/** POST one batch, retrying transient failures (network, 401 after refresh, 5xx/429). */
	private async _deliver(sessionId: string, batch: IRelayEvent[]): Promise<void> {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const token = await this._options.getToken().catch(() => undefined);
			if (!token) {
				return; // signed out — nothing to deliver to
			}
			try {
				const res = await this._fetch(`${this._options.getUrl()}/api/sessions/${sessionId}/events`, {
					method: 'POST',
					headers: this._headers(token),
					body: JSON.stringify(batch),
				});
				if (res.ok) {
					return;
				}
				if (res.status === 404) {
					// The daemon lost the session (restart, expiry): create it again and
					// deliver this batch there rather than drop it.
					this._buffer.unshift(...batch);
					this._sessionLost(sessionId);
					return;
				}
				// 4xx other than auth/rate-limit won't succeed on retry (bad event, unknown session).
				if (res.status !== 401 && res.status !== 429 && res.status < 500) {
					this._options.log?.(`relay dropped ${batch.length} event(s): HTTP ${res.status}`);
					return;
				}
			} catch {
				/* network — retry */
			}
			if (attempt < MAX_ATTEMPTS) {
				await new Promise(resolve => setTimeout(resolve, 500 * attempt));
			}
		}
		this._options.log?.(`relay dropped ${batch.length} event(s) after ${MAX_ATTEMPTS} attempts`);
	}

	private _openCommands(id: string): void {
		this._commandAbort?.abort();
		const ac = new AbortController();
		this._commandAbort = ac;
		void this._readCommands(id, ac);
	}

	/**
	 * Hold the command channel open while the session is current. Reconnects with
	 * jittered exponential backoff (reset once a connection delivered data), drops
	 * a connection that has gone silent past {@link COMMAND_IDLE_MS}, and creates
	 * the session again when the daemon no longer knows it (404).
	 */
	private async _readCommands(id: string, ac: AbortController): Promise<void> {
		let attempt = 0;
		while (!ac.signal.aborted && this._sessionId === id) {
			// One abort per connection, so the idle watchdog can drop just this one.
			const connection = new AbortController();
			const onAbort = () => connection.abort();
			ac.signal.addEventListener('abort', onAbort);
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const touch = () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					this._options.log?.('command channel silent; reconnecting');
					connection.abort();
				}, COMMAND_IDLE_MS);
			};
			try {
				// Signed out for now: back off and look again (a new sign-in resumes the channel).
				const token = await this._options.getToken().catch(() => undefined);
				touch(); // also bounds a connect that never answers
				const res = token ? await this._fetch(`${this._options.getUrl()}/api/sessions/${id}/commands`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: connection.signal,
				}) : undefined;
				if (res?.status === 404) {
					this._sessionLost(id);
					return;
				}
				const reader = res?.ok ? res.body?.getReader() : undefined;
				const decoder = new TextDecoder();
				let buf = '';
				while (reader) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					touch();
					attempt = 0; // the channel works: the next drop retries quickly
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split('\n');
					buf = lines.pop() ?? '';
					for (const line of lines) {
						if (!line.startsWith('data:')) {
							continue;
						}
						const payload = line.slice(5).trim();
						if (!payload) {
							continue;
						}
						try {
							this._handleCommand(JSON.parse(payload));
						} catch {
							/* ignore malformed frame */
						}
					}
				}
			} catch {
				if (ac.signal.aborted) {
					return;
				}
			} finally {
				clearTimeout(idleTimer);
				ac.signal.removeEventListener('abort', onAbort);
			}
			await this._backoff(ac, relayReconnectDelay(attempt++, (this._options.random ?? Math.random)()));
		}
	}

	/**
	 * The daemon no longer knows session `id` (it restarted or expired it): forget
	 * it and create a new one with the same title, task and mirror key, carrying
	 * the last state over so the phone sees where the run is.
	 */
	private _sessionLost(id: string): void {
		if (this._sessionId !== id || this._disposed) {
			return;
		}
		this._options.log?.(`relay session ${id} is gone; creating it again`);
		this._commandAbort?.abort();
		this._commandAbort = undefined;
		this._sessionId = undefined;
		if (this._lastStateEvent && !this._buffer.includes(this._lastStateEvent)) {
			this._buffer.unshift(this._lastStateEvent);
		}
		this._recreateAbort?.abort();
		const recreate = new AbortController();
		this._recreateAbort = recreate;
		void this._recreate(recreate);
	}

	/** Create the session again (see {@link _sessionLost}), backing off while the daemon is unreachable. */
	private async _recreate(ac: AbortController): Promise<void> {
		const args = this._startArgs;
		for (let attempt = 0; args && !ac.signal.aborted && !this._disposed && !this._sessionId && !this._mirroredElsewhere; attempt++) {
			await this.start(args.title, args.taskId, args.mirrorKey);
			if (this._sessionId || this._mirroredElsewhere) {
				return;
			}
			await this._backoff(ac, relayReconnectDelay(attempt, (this._options.random ?? Math.random)()));
		}
	}

	private _handleCommand(cmd: IRelayCommand): void {
		if (cmd.kind === 'instruct' && typeof cmd.text === 'string') {
			this._options.onInstruct?.(cmd.text);
		} else if (cmd.kind === 'answer' && typeof cmd.text === 'string') {
			// Answer a pending question when we can target it; else treat as an instruction.
			if (cmd.requestId) {
				this._options.onAnswer?.(cmd.requestId, cmd.text);
			} else {
				this._options.onInstruct?.(cmd.text);
			}
		} else if (cmd.kind === 'cancel') {
			this._options.onCancel?.();
		} else if ((cmd.kind === 'approve' || cmd.kind === 'reject') && cmd.requestId) {
			this._options.onApprovalDecision?.(cmd.requestId, cmd.kind === 'approve');
		} else if ((cmd.kind === 'fs.list' || cmd.kind === 'fs.read' || cmd.kind === 'fs.write') && cmd.requestId) {
			this._options.onFsCommand?.(cmd.kind, cmd.requestId, cmd.path ?? '', cmd.content);
		} else if ((cmd.kind === 'git.status' || cmd.kind === 'git.diff' || cmd.kind === 'git.commit' || cmd.kind === 'git.revert' || cmd.kind === 'git.push' || cmd.kind === 'git.pr' || cmd.kind === 'git.merge') && cmd.requestId) {
			this._options.onGitCommand?.(cmd.kind, cmd.requestId, { path: cmd.path, message: cmd.message, paths: cmd.paths, title: cmd.title, body: cmd.body, base: cmd.base, method: cmd.method, head: typeof cmd.head === 'string' ? cmd.head : undefined });
		}
	}

	/** Wait `delayMs`, or less if the channel is aborted; leaves no listener behind either way. */
	private _backoff(ac: AbortController, delayMs: number): Promise<void> {
		return new Promise<void>(resolve => {
			const done = () => {
				clearTimeout(timer);
				ac.signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = setTimeout(done, delayMs);
			ac.signal.addEventListener('abort', done, { once: true });
		});
	}
}
