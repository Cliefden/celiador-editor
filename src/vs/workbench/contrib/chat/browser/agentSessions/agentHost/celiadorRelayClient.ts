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
}

/** The kinds of filesystem command the phone can round-trip to this runner. */
export type RelayFsKind = 'fs.list' | 'fs.read' | 'fs.write';

/** The kinds of run-review (git) command the phone can round-trip to this runner. */
export type RelayGitKind = 'git.status' | 'git.diff' | 'git.commit' | 'git.revert' | 'git.push' | 'git.pr';

/** The per-kind arguments of a relayed git command (see {@link IRelayCommand}). */
export interface IRelayGitArgs {
	readonly path?: string;
	readonly message?: string;
	readonly paths?: string[];
	readonly title?: string;
	readonly body?: string;
	readonly base?: string;
}

/** Debounce window for coalescing high-frequency events (streamed deltas). */
const FLUSH_MS = 150;
/** Reconnect backoff for the command channel. */
const RECONNECT_MS = 1500;
/** Kinds that should reach the phone immediately rather than wait for a flush. */
const URGENT = new Set(['approval', 'question', 'state', 'done', 'error', 'fs.result']);
/** Delivery attempts per batch before it's dropped (relay is best-effort). */
const MAX_ATTEMPTS = 3;
/** Events buffered before the relay session exists (start() is async — a fast
 * run streams deltas before the create round-trip finishes; don't drop them). */
const MAX_PRESTART_BUFFER = 500;

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

	constructor(private readonly _options: ICeliadorRelayClientOptions) {
		super();
	}

	/** True once a session exists (so events will actually be relayed). */
	get active(): boolean {
		return !!this._sessionId;
	}

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/** Lazily create the session (titled by the first prompt) and open its command channel. */
	async start(title: string): Promise<void> {
		if (this._sessionId || this._disposed) {
			return;
		}
		const token = await this._options.getToken();
		if (!token) {
			return; // signed out → local-only, no relay
		}
		try {
			const res = await fetch(`${this._options.getUrl()}/api/sessions`, {
				method: 'POST',
				headers: this._headers(token),
				body: JSON.stringify({ title, origin: 'editor', runner: 'editor' }),
			});
			if (!res.ok) {
				return;
			}
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
		if (this._disposed) {
			return;
		}
		if (event.kind === 'state') {
			if (event.state === this._lastState) {
				return; // collapse repeats
			}
			this._lastState = event.state as string;
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
		this._sessionId = undefined;
		this._lastState = undefined;
	}

	override dispose(): void {
		// Drain buffered events (e.g. the final state/done) before going inert, so the
		// phone isn't left showing a run as still in progress.
		void this._flush();
		this._disposed = true;
		this._commandAbort?.abort();
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
				const res = await fetch(`${this._options.getUrl()}/api/sessions/${sessionId}/events`, {
					method: 'POST',
					headers: this._headers(token),
					body: JSON.stringify(batch),
				});
				if (res.ok) {
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

	private async _readCommands(id: string, ac: AbortController): Promise<void> {
		while (!ac.signal.aborted && this._sessionId === id) {
			try {
				const token = await this._options.getToken();
				if (!token) {
					return;
				}
				const res = await fetch(`${this._options.getUrl()}/api/sessions/${id}/commands`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: ac.signal,
				});
				if (!res.ok || !res.body) {
					await this._backoff(ac);
					continue;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = '';
				for (; ;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
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
			}
			await this._backoff(ac);
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
		} else if ((cmd.kind === 'git.status' || cmd.kind === 'git.diff' || cmd.kind === 'git.commit' || cmd.kind === 'git.revert' || cmd.kind === 'git.push' || cmd.kind === 'git.pr') && cmd.requestId) {
			this._options.onGitCommand?.(cmd.kind, cmd.requestId, { path: cmd.path, message: cmd.message, paths: cmd.paths, title: cmd.title, body: cmd.body, base: cmd.base });
		}
	}

	private _backoff(ac: AbortController): Promise<void> {
		return new Promise<void>(resolve => {
			const t = setTimeout(resolve, RECONNECT_MS);
			ac.signal.addEventListener('abort', () => {
				clearTimeout(t);
				resolve();
			}, { once: true });
		});
	}
}
