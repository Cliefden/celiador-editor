/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Disposable, DisposableStore, IReference } from '../../../../../../base/common/lifecycle.js';
import { isEqualOrParent, joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { ActionEnvelope, ChatInputCompletedAction, ChatPendingMessageSetAction, ChatToolCallConfirmedAction, ChatTurnStartedAction } from '../../../../../../platform/agentHost/common/state/protocol/actions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputResponseKind, MessageKind, PendingMessageKind, ToolCallCancellationReason, ToolCallConfirmationReason } from '../../../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { SessionState, StateComponents } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { ChatSessionStatus } from '../../../common/chatSessionsService.js';
import { isAgentHostTarget } from '../agentSessions.js';
import { IAgentSessionsService } from '../agentSessionsService.js';
import { CeliadorRelayClient, RelayFsKind, RelayGitKind } from './celiadorRelayClient.js';

/**
 * Celiador: editor-as-runner relay bridge. Mirrors each live local agent-host
 * (Claude) session to the daemon's session relay so the companion phone can watch
 * and steer it. The editor stays the runner (the agent + tools run locally on the
 * real workspace — the hybrid model); this only publishes what each session is
 * doing and relays control back. Everything here is best-effort.
 *
 * Scope:
 * - OBSERVE (state): running / awaiting / done / error, titled by the session label.
 * - OBSERVE (transcript): streamed assistant text (`delta`), tool calls (`tool`) and
 *   the agent's current-activity line (`activity`), read from the session's default
 *   chat action stream.
 * - CANCEL: the phone can cancel a run.
 *
 * Deferred (v2b): completed assistant messages + tool results + diffs; remote
 * approvals (per-session, via the chat `ChatToolCallReady` confirmation stream) and
 * questions; and follow-up instructions (client-action `dispatch`).
 *
 * Auth token comes from the registered `celiador` VS Code authentication provider
 * (the same Supabase session that routes the agent through the daemon); the daemon
 * URL from `product.celiadorDaemonUrl`.
 */
export class CeliadorRelayBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.celiadorRelayBridge';

	/** Must match the auth provider id registered by the celiador-ai extension. */
	private static readonly AUTH_PROVIDER_ID = 'celiador';
	private static readonly FALLBACK_DAEMON_URL = 'https://celiador.ai';
	/** Largest file we send to the phone as text; larger is returned truncated. */
	private static readonly MAX_FILE_BYTES = 1_000_000;

	/** sessionResource.toString() → the relay client mirroring it. */
	private readonly _clients = new Map<string, CeliadorRelayClient>();
	/** sessionResource.toString() → last published status (de-dupes repeats). */
	private readonly _lastStatus = new Map<string, ChatSessionStatus>();
	/** sessionResource.toString() → its session-state subscription + resolved default chat channel. */
	private readonly _watches = new Map<string, { readonly ref: IReference<IAgentSubscription<SessionState>>; readonly store: DisposableStore; chatChannel: string | undefined }>();
	/** chat channel URI string → owning sessionResource.toString() (routes action events). */
	private readonly _chatChannelToKey = new Map<string, string>();
	/** toolCallId → tool display name (captured at ChatToolCallStart, used to label approvals). */
	private readonly _toolNameByCallId = new Map<string, string>();
	/** requestId (= toolCallId) → what a phone approve/deny must dispatch back. */
	private readonly _pendingApprovals = new Map<string, { readonly chatChannel: string; readonly turnId: string; readonly toolCallId: string }>();
	/** input request id → what a phone answer must dispatch back. */
	private readonly _pendingQuestions = new Map<string, { readonly chatChannel: string; readonly questionId: string }>();

	constructor(
		@IAgentSessionsService private readonly _sessionsService: IAgentSessionsService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IChatService private readonly _chatService: IChatService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		// Accessing `.model` lazily resolves all session providers; its change event
		// then drives reconciliation.
		const model = this._sessionsService.model;
		this._register(model.onDidChangeSessions(() => this._reconcile()));
		// One connection-wide action listener, routed to the owning session's relay
		// by the action's channel (the session's default chat URI).
		this._register(this._agentHostService.onDidAction(envelope => this._onAction(envelope)));
		this._reconcile();
	}

	private _daemonUrl(): string {
		return (this._productService.celiadorDaemonUrl ?? CeliadorRelayBridge.FALLBACK_DAEMON_URL).replace(/\/+$/, '');
	}

	private async _token(): Promise<string | undefined> {
		try {
			const sessions = await this._authenticationService.getSessions(CeliadorRelayBridge.AUTH_PROVIDER_ID, []);
			return sessions[0]?.accessToken;
		} catch {
			return undefined;
		}
	}

	private _reconcile(): void {
		const live = new Map<string, { readonly resource: URI; readonly status: ChatSessionStatus; readonly label: string }>();
		for (const session of this._sessionsService.model.sessions) {
			if (isAgentHostTarget(session.providerType)) {
				live.set(session.resource.toString(), { resource: session.resource, status: session.status, label: session.label });
			}
		}

		// Drop clients whose session no longer exists.
		for (const key of [...this._clients.keys()]) {
			if (!live.has(key)) {
				this._disposeClient(key);
			}
		}

		for (const [key, session] of live) {
			const active = session.status === ChatSessionStatus.InProgress || session.status === ChatSessionStatus.NeedsInput;
			let client = this._clients.get(key);

			if (!client) {
				// Only start relaying once a session is actually active — don't mirror
				// the whole completed-session history on startup.
				if (!active) {
					continue;
				}
				client = this._createClient(key, session.resource);
				const title = session.label || 'Agent session';
				void client.start(title).then(() => {
					// Publish the current status once the relay session exists.
					const current = this._sessionsService.model.getSession(session.resource);
					if (current && this._clients.get(key) === client) {
						this._publishStatus(key, current.status, client!);
					}
				});
				continue;
			}

			// Publish status changes but KEEP the relay client (and its command
			// channel) attached through terminal states: a finished run is exactly
			// when the phone reviews it (git status/diff/commit/revert), browses
			// files, or sends a follow-up that starts the next turn. The client is
			// dropped when the session leaves the model (above) or on dispose.
			this._publishStatus(key, session.status, client);
		}
	}

	private _createClient(key: string, resource: URI): CeliadorRelayClient {
		const client = new CeliadorRelayClient({
			getUrl: () => this._daemonUrl(),
			getToken: () => this._token(),
			log: message => this._logService.trace(`[celiador-relay] ${message}`),
			onCancel: () => { void this._chatService.cancelCurrentRequestForSession(resource, 'celiador-phone'); },
			onApprovalDecision: (requestId, approved) => this._resolveApproval(requestId, approved),
			onInstruct: (text) => this._sendInstruction(key, text),
			onAnswer: (requestId, text) => this._answerQuestion(requestId, text),
			onFsCommand: (kind, requestId, path, content) => { void this._handleFsCommand(key, kind, requestId, path, content); },
			onGitCommand: (kind, requestId, args) => { void this._handleGitCommand(key, kind, requestId, args); },
		});
		this._clients.set(key, client);
		this._watchSession(key, resource);
		return client;
	}

	/** Subscribe to the session's state so we can route its default-chat actions to the relay. */
	private _watchSession(key: string, resource: URI): void {
		const ref = this._agentHostService.getSubscription(StateComponents.Session, resource, 'CeliadorRelayBridge');
		const store = new DisposableStore();
		store.add(ref);
		const watch = { ref, store, chatChannel: undefined as string | undefined };
		this._watches.set(key, watch);
		const update = () => {
			const state = ref.object.value;
			const next = state && !(state instanceof Error) ? state.defaultChat?.toString() : undefined;
			if (next === watch.chatChannel) {
				return;
			}
			if (watch.chatChannel) {
				this._chatChannelToKey.delete(watch.chatChannel);
			}
			watch.chatChannel = next;
			if (next) {
				this._chatChannelToKey.set(next, key);
			}
		};
		store.add(ref.object.onDidChange(() => update()));
		update();
	}

	/** Route one connection action to the owning session's relay and map it to a relay event. */
	private _onAction(envelope: ActionEnvelope): void {
		const key = this._chatChannelToKey.get(envelope.channel.toString());
		if (!key) {
			return;
		}
		const client = this._clients.get(key);
		if (!client || !client.active) {
			return;
		}
		const action = envelope.action;
		switch (action.type) {
			case ActionType.ChatDelta:
				if (action.content.length > 0) {
					client.publish({ kind: 'delta', text: action.content });
				}
				break;
			case ActionType.ChatToolCallStart:
				this._toolNameByCallId.set(action.toolCallId, action.toolName);
				client.publish({ kind: 'tool', callId: action.toolCallId, name: action.toolName, input: {} });
				break;
			case ActionType.ChatToolCallReady:
				// `confirmed` unset → the tool is waiting for user approval. Relay it so
				// the phone can approve/deny; a set `confirmed` means it auto-approved.
				if (action.confirmed === undefined) {
					const title = action.confirmationTitle ?? action.invocationMessage;
					this._pendingApprovals.set(action.toolCallId, { chatChannel: envelope.channel.toString(), turnId: action.turnId, toolCallId: action.toolCallId });
					client.publish({
						kind: 'approval',
						requestId: action.toolCallId,
						approvalKind: this._toolNameByCallId.get(action.toolCallId) ?? 'tool',
						title: typeof title === 'string' ? title : title.markdown,
					});
				}
				break;
			case ActionType.ChatToolCallConfirmed:
			case ActionType.ChatToolCallComplete:
				// Resolved (locally or remotely) — drop any stale pending approval.
				this._pendingApprovals.delete(action.toolCallId);
				this._toolNameByCallId.delete(action.toolCallId);
				break;
			case ActionType.ChatInputRequested: {
				// The agent is asking the user something — relay it so the phone shows the
				// question, and remember the first question id so a phone answer can target it.
				const request = action.request;
				const questionId = request.questions?.[0]?.id;
				if (questionId) {
					this._pendingQuestions.set(request.id, { chatChannel: envelope.channel.toString(), questionId });
				}
				client.publish({
					kind: 'question',
					requestId: request.id,
					prompt: request.message || request.questions?.[0]?.message || 'The agent needs your input.',
				});
				break;
			}
			case ActionType.ChatInputCompleted:
				this._pendingQuestions.delete(action.requestId);
				break;
			case ActionType.ChatActivityChanged:
				if (action.activity && action.activity.length > 0) {
					client.publish({ kind: 'activity', text: action.activity });
				}
				break;
		}
	}

	/** A phone approve/deny arrived: dispatch the matching tool-call confirmation back to the agent. */
	private _resolveApproval(requestId: string, approved: boolean): void {
		const pending = this._pendingApprovals.get(requestId);
		if (!pending) {
			return;
		}
		this._pendingApprovals.delete(requestId);
		const action: ChatToolCallConfirmedAction = approved
			? { type: ActionType.ChatToolCallConfirmed, approved: true, confirmed: ToolCallConfirmationReason.UserAction, turnId: pending.turnId, toolCallId: pending.toolCallId }
			: { type: ActionType.ChatToolCallConfirmed, approved: false, reason: ToolCallCancellationReason.Denied, turnId: pending.turnId, toolCallId: pending.toolCallId };
		this._agentHostService.dispatch(pending.chatChannel, action);
	}

	/**
	 * A phone follow-up arrived. If a turn is already running, queue it (the server
	 * starts it as a new turn once the current one finishes); only when the session
	 * is idle do we start a turn immediately — dispatching a second `ChatTurnStarted`
	 * over a live turn would race the in-flight one.
	 */
	private _sendInstruction(key: string, text: string): void {
		const chatChannel = this._watches.get(key)?.chatChannel;
		if (!chatChannel || !text.trim()) {
			return;
		}
		const message = { text, origin: { kind: MessageKind.User } };
		if (this._lastStatus.get(key) === ChatSessionStatus.InProgress) {
			const action: ChatPendingMessageSetAction = {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: generateUuid(),
				message,
			};
			this._agentHostService.dispatch(chatChannel, action);
			return;
		}
		const action: ChatTurnStartedAction = {
			type: ActionType.ChatTurnStarted,
			turnId: generateUuid(),
			startedAt: new Date().toISOString(),
			message,
		};
		this._agentHostService.dispatch(chatChannel, action);
	}

	/** A phone answer arrived: complete the pending input request with the text as the answer. */
	private _answerQuestion(requestId: string, text: string): void {
		const pending = this._pendingQuestions.get(requestId);
		if (!pending) {
			return;
		}
		this._pendingQuestions.delete(requestId);
		const action: ChatInputCompletedAction = {
			type: ActionType.ChatInputCompleted,
			requestId,
			response: ChatInputResponseKind.Accept,
			answers: {
				[pending.questionId]: {
					state: ChatInputAnswerState.Submitted,
					value: { kind: ChatInputAnswerValueKind.Text, value: text },
				},
			},
		};
		this._agentHostService.dispatch(pending.chatChannel, action);
	}

	/**
	 * A phone file-browser request arrived (list / read / write). Perform it against
	 * the real workspace via the file service, scoped to the first workspace folder,
	 * and publish the answer back as an `fs.result` carrying the same `requestId`.
	 */
	private async _handleFsCommand(key: string, kind: RelayFsKind, requestId: string, path: string, content: string | undefined): Promise<void> {
		const client = this._clients.get(key);
		if (!client) {
			return;
		}
		try {
			const root = this._workspaceService.getWorkspace().folders[0]?.uri;
			if (!root) {
				throw new Error('no workspace open');
			}
			const target = this._resolveInWorkspace(root, path);
			if (!target) {
				throw new Error('bad path');
			}
			if (kind === 'fs.list') {
				const stat = await this._fileService.resolve(target);
				const entries = (stat.children ?? [])
					.filter(child => child.name !== '.git')
					.map(child => ({ name: child.name, type: child.isDirectory ? 'dir' : 'file', size: child.size }))
					.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
				client.publish({ kind: 'fs.result', requestId, ok: true, entries });
			} else if (kind === 'fs.read') {
				const file = await this._fileService.readFile(target);
				const bytes = file.value.buffer;
				if (bytes.includes(0)) {
					client.publish({ kind: 'fs.result', requestId, ok: false, error: 'binary file' });
					return;
				}
				const truncated = bytes.length > CeliadorRelayBridge.MAX_FILE_BYTES;
				const slice = truncated ? bytes.subarray(0, CeliadorRelayBridge.MAX_FILE_BYTES) : bytes;
				client.publish({ kind: 'fs.result', requestId, ok: true, content: new TextDecoder().decode(slice), encoding: 'utf8', truncated });
			} else {
				await this._fileService.writeFile(target, VSBuffer.fromString(content ?? ''));
				client.publish({ kind: 'fs.result', requestId, ok: true });
			}
		} catch (err) {
			client.publish({ kind: 'fs.result', requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * A phone run-review request arrived (git status / diff / commit / revert).
	 * Delegate to the celiador-ai extension's `celiador.relayGit` command — the
	 * extension host runs it through the vscode.git machinery — and publish the
	 * result back as an `fs.result` carrying the same `requestId`.
	 */
	private async _handleGitCommand(key: string, kind: RelayGitKind, requestId: string, args: { path?: string; message?: string; paths?: string[] }): Promise<void> {
		const client = this._clients.get(key);
		if (!client) {
			return;
		}
		try {
			const result = await this._commandService.executeCommand<{ ok: boolean;[key: string]: unknown }>('celiador.relayGit', { kind, ...args });
			if (!result) {
				throw new Error('run review is unavailable');
			}
			client.publish({ ...result, kind: 'fs.result', requestId });
		} catch (err) {
			client.publish({ kind: 'fs.result', requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/** Resolve a workspace-relative path under `root`, rejecting any `..` escape. */
	private _resolveInWorkspace(root: URI, rel: string): URI | undefined {
		const segments = (rel ?? '').split('/').filter(segment => segment.length > 0 && segment !== '.');
		if (segments.some(segment => segment === '..')) {
			return undefined;
		}
		const target = segments.length ? joinPath(root, ...segments) : root;
		return isEqualOrParent(target, root) ? target : undefined;
	}

	/** Publish a status change; only once the relay session is live, and only on change. */
	private _publishStatus(key: string, status: ChatSessionStatus, client: CeliadorRelayClient): void {
		if (!client.active || this._lastStatus.get(key) === status) {
			return;
		}
		this._lastStatus.set(key, status);
		switch (status) {
			case ChatSessionStatus.InProgress:
				client.publish({ kind: 'state', state: 'running' });
				break;
			case ChatSessionStatus.NeedsInput:
				client.publish({ kind: 'state', state: 'awaiting' });
				break;
			case ChatSessionStatus.Completed:
				// The `state` event is what actually moves the daemon's session state —
				// without it a finished run stays "running" until the command channel
				// drops and the daemon writes it off as disconnected.
				client.publish({ kind: 'done' });
				client.publish({ kind: 'state', state: 'done' });
				break;
			case ChatSessionStatus.Failed:
				client.publish({ kind: 'error', message: 'The agent run failed.' });
				client.publish({ kind: 'state', state: 'error' });
				break;
		}
	}

	private _disposeClient(key: string): void {
		const client = this._clients.get(key);
		if (client) {
			client.reset(); // flushes any buffered events (e.g. the terminal done/error) then closes the command channel
			client.dispose();
			this._clients.delete(key);
		}
		const watch = this._watches.get(key);
		if (watch) {
			if (watch.chatChannel) {
				this._chatChannelToKey.delete(watch.chatChannel);
				// Drop pending approvals/questions that belonged to this session's chat channel.
				for (const [requestId, pending] of this._pendingApprovals) {
					if (pending.chatChannel === watch.chatChannel) {
						this._pendingApprovals.delete(requestId);
					}
				}
				for (const [requestId, pending] of this._pendingQuestions) {
					if (pending.chatChannel === watch.chatChannel) {
						this._pendingQuestions.delete(requestId);
					}
				}
			}
			watch.store.dispose();
			this._watches.delete(key);
		}
		this._lastStatus.delete(key);
	}

	override dispose(): void {
		for (const client of this._clients.values()) {
			client.dispose();
		}
		for (const watch of this._watches.values()) {
			watch.store.dispose();
		}
		this._clients.clear();
		this._watches.clear();
		this._lastStatus.clear();
		this._chatChannelToKey.clear();
		this._toolNameByCallId.clear();
		this._pendingApprovals.clear();
		this._pendingQuestions.clear();
		super.dispose();
	}
}
