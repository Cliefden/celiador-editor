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
import { IAgentHostConnectionsService, LOCAL_AGENT_HOST_SCHEME_PREFIX } from '../../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { ActionEnvelope, ChatInputCompletedAction, ChatPendingMessageSetAction, ChatToolCallConfirmedAction, ChatTurnStartedAction } from '../../../../../../platform/agentHost/common/state/protocol/actions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputResponseKind, MessageKind, PendingMessageKind, ToolCallCancellationReason, ToolCallConfirmationReason } from '../../../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { buildDefaultChatUri, getCanonicalOpaqueChatUuid, parseChatUri, SessionState, StateComponents } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { ChatSessionStatus } from '../../../common/chatSessionsService.js';
import { isAgentHostTarget } from '../agentSessions.js';
import { IAgentSessionsService } from '../agentSessionsService.js';
import { CeliadorRelayClient, IRelayGitArgs, RelayFsKind, RelayGitKind } from './celiadorRelayClient.js';
import { getCeliadorTaskRun } from './celiadorTaskRuns.js';

type PhoneCommandClassification = {
	command: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Which steering command the companion phone sent: cancel, approve, reject, instruct, answer, fs.*, git.*.' };
	owner: 'celiador';
	comment: 'A command from the Celiador companion phone reached the editor relay bridge.';
};
type PhoneCommandEvent = {
	command: string;
};
type SessionMirroredClassification = {
	owner: 'celiador';
	comment: 'A local agent session started being mirrored to the companion phone.';
};

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
	/** sessionResource.toString() → its session-state subscription + resolved chat channels (primary = where instructions dispatch). */
	private readonly _watches = new Map<string, { readonly ref: IReference<IAgentSubscription<SessionState>>; readonly store: DisposableStore; readonly backend: string; chatChannels: Set<string>; primary: string | undefined }>();
	/** backend session URI (`ahp-session:/<id>`) string → owning sessionResource.toString() (routes session-channel actions). */
	private readonly _backendToKey = new Map<string, string>();
	/** chat channel URI string → owning sessionResource.toString() (routes action events). */
	private readonly _chatChannelToKey = new Map<string, string>();
	/** Channels we've already trace-logged as unrouted (avoid per-delta spam). */
	private readonly _unroutedLogged = new Set<string>();
	/**
	 * Chat actions that arrived before their session had a relay client. A NEW
	 * session dispatches (and echoes) its first `ChatTurnStarted` while the
	 * provider is still awaiting `sendRequest`; only afterwards is the session
	 * marked in-progress and added to the model, which is what makes
	 * {@link _reconcile} create the client. Without this buffer the user's first
	 * message is dropped and the phone sees an answer with no question
	 * (Cliefden/daemon#8). Bounded and aged out; replayed by {@link _replayEarlyActions}.
	 */
	private _earlyActions: { readonly envelope: ActionEnvelope; readonly at: number }[] = [];
	private static readonly MAX_EARLY_ACTIONS = 200;
	private static readonly EARLY_ACTION_TTL_MS = 60_000;
	/** toolCallId → tool display name (captured at ChatToolCallStart, used to label approvals). */
	private readonly _toolNameByCallId = new Map<string, string>();
	/** requestId (= toolCallId) → what a phone approve/deny must dispatch back. */
	private readonly _pendingApprovals = new Map<string, { readonly chatChannel: string; readonly turnId: string; readonly toolCallId: string }>();
	/** Texts of turns the phone itself dispatched — their ChatTurnStarted echo must
	 * not be re-published as a user message (the daemon already logged it). */
	private readonly _phoneSentTexts: string[] = [];
	/** input request id → what a phone answer must dispatch back. */
	private readonly _pendingQuestions = new Map<string, { readonly chatChannel: string; readonly questionId: string }>();

	constructor(
		@IAgentSessionsService private readonly _sessionsService: IAgentSessionsService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IAgentHostConnectionsService private readonly _connectionsService: IAgentHostConnectionsService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IChatService private readonly _chatService: IChatService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
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
				void client.start(title, getCeliadorTaskRun(key)?.taskId, this._mirrorKey(session.resource)).then(() => {
					// Publish the current status once the relay session exists.
					const current = this._sessionsService.model.getSession(session.resource);
					if (current && this._clients.get(key) === client) {
						this._publishStatus(key, current.status, client!);
					}
				});
				continue;
			}

			// Another window mirrors this session: stay quiet, but re-claim on a new
			// turn in case that window has since closed (throttled in the client).
			if (client.mirroredElsewhere) {
				if (active) {
					void client.start(session.label || 'Agent session', getCeliadorTaskRun(key)?.taskId, this._mirrorKey(session.resource));
				}
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
			onCancel: () => { this._trackPhoneCommand('cancel'); void this._chatService.cancelCurrentRequestForSession(resource, 'celiador-phone'); },
			onApprovalDecision: (requestId, approved) => { this._trackPhoneCommand(approved ? 'approve' : 'reject'); this._resolveApproval(requestId, approved); },
			onInstruct: (text) => { this._trackPhoneCommand('instruct'); this._sendInstruction(key, text); },
			onAnswer: (requestId, text) => { this._trackPhoneCommand('answer'); this._answerQuestion(requestId, text); },
			onFsCommand: (kind, requestId, path, content) => { this._trackPhoneCommand(kind); void this._handleFsCommand(key, kind, requestId, path, content); },
			onGitCommand: (kind, requestId, args) => { this._trackPhoneCommand(kind); void this._handleGitCommand(key, kind, requestId, args); },
		});
		this._clients.set(key, client);
		this._watchSession(key, resource);
		this._replayEarlyActions(key);
		this._telemetryService.publicLog2<{}, SessionMirroredClassification>('celiador/relaySessionMirrored');
		return client;
	}

	/** Product telemetry: which steering commands the phone actually uses (no content, no ids). */
	private _trackPhoneCommand(command: string): void {
		this._telemetryService.publicLog2<PhoneCommandEvent, PhoneCommandClassification>('celiador/phoneCommand', { command });
	}

	/** Remember a chat action whose session has no relay client yet (see {@link _earlyActions}). */
	private _bufferEarlyAction(envelope: ActionEnvelope): void {
		const now = Date.now();
		this._earlyActions = this._earlyActions.filter(entry => now - entry.at <= CeliadorRelayBridge.EARLY_ACTION_TTL_MS);
		this._earlyActions.push({ envelope, at: now });
		if (this._earlyActions.length > CeliadorRelayBridge.MAX_EARLY_ACTIONS) {
			this._earlyActions.splice(0, this._earlyActions.length - CeliadorRelayBridge.MAX_EARLY_ACTIONS);
		}
	}

	/** Route buffered early actions that now resolve to the freshly created client, in arrival order. */
	private _replayEarlyActions(key: string): void {
		if (this._earlyActions.length === 0) {
			return;
		}
		const now = Date.now();
		const keep: typeof this._earlyActions = [];
		const replay: ActionEnvelope[] = [];
		for (const entry of this._earlyActions) {
			if (now - entry.at > CeliadorRelayBridge.EARLY_ACTION_TTL_MS) {
				continue;
			}
			if (this._resolveActionKey(entry.envelope.channel.toString()) === key) {
				replay.push(entry.envelope);
			} else {
				keep.push(entry);
			}
		}
		this._earlyActions = keep;
		if (replay.length > 0) {
			this._logService.trace(`[celiador-relay] replaying ${replay.length} early action(s) for ${key}`);
			for (const envelope of replay) {
				this._onAction(envelope);
			}
		}
	}

	/**
	 * Subscribe to the session's state so we can route its chat actions to the
	 * relay. Maps EVERY chat channel of the session (default + peers), not just
	 * `defaultChat` — a chat typed directly into the sidebar can live on a peer
	 * channel (and `defaultChat` can be unset) and would otherwise route nothing.
	 */
	private _watchSession(key: string, resource: URI): void {
		// The agent host addresses sessions by their backend URI (`ahp-session:/<id>`),
		// not the model resource (`agent-host-claude:/<id>`); subscribing with the
		// model resource fails with "Session not found on backend".
		const backend = this._backendSession(resource);
		this._backendToKey.set(backend.toString(), key);
		const ref = this._agentHostService.getSubscription(StateComponents.Session, backend, 'CeliadorRelayBridge');
		const store = new DisposableStore();
		store.add(ref);
		const watch = { ref, store, backend: backend.toString(), chatChannels: new Set<string>(), primary: undefined as string | undefined };
		this._watches.set(key, watch);
		const update = () => {
			const state = ref.object.value;
			const next = new Set<string>();
			let primary: string | undefined;
			if (state && !(state instanceof Error)) {
				if (state.defaultChat) {
					next.add(state.defaultChat.toString());
				}
				for (const chat of state.chats ?? []) {
					if (chat.resource) {
						next.add(chat.resource.toString());
					}
				}
				// Upstream no longer derives the default chat from its URI shape; the
				// host advertises it as `defaultChat`.
				primary = state.defaultChat?.toString()
					?? state.chats?.[0]?.resource?.toString();
			}
			watch.primary = primary;
			for (const old of watch.chatChannels) {
				if (!next.has(old)) {
					this._chatChannelToKey.delete(old);
				}
			}
			for (const channel of next) {
				if (!watch.chatChannels.has(channel)) {
					this._logService.trace(`[celiador-relay] routing chat channel ${channel}`);
				}
				this._chatChannelToKey.set(channel, key);
			}
			watch.chatChannels = next;
		};
		store.add(ref.object.onDidChange(() => update()));
		update();
	}

	/**
	 * The backend session URI the agent host uses for a model session resource,
	 * resolved through upstream's connections service. Falls back to stripping
	 * the local agent-host scheme prefix for sessions it cannot resolve yet.
	 */
	private _backendSession(resource: URI): URI {
		const identity = this._connectionsService.resolveSessionResourceIdentity(resource);
		if (identity) {
			return identity.backendSession;
		}
		const value = resource.toString();
		return URI.parse(value.startsWith(LOCAL_AGENT_HOST_SCHEME_PREFIX) ? value.slice(LOCAL_AGENT_HOST_SCHEME_PREFIX.length) : value);
	}

	/**
	 * The agent session's identity across windows: every editor window and the
	 * Agents window run this bridge over the same machine-wide agent host, so the
	 * daemon keys on the backend session to keep one mirror (and one phone entry).
	 */
	private _mirrorKey(resource: URI): string {
		return this._backendSession(resource).toString();
	}

	/**
	 * Resolve which mirrored session an action channel belongs to. Chat actions
	 * arrive on chat channel URIs that the session-state watch maps to their
	 * session (chat URIs no longer encode their session); session-level actions
	 * arrive on the backend session URI. Subagent chats are excluded — their
	 * deltas would pollute the phone transcript.
	 */
	private _resolveActionKey(channel: string): string | undefined {
		const direct = this._chatChannelToKey.get(channel) ?? this._backendToKey.get(channel);
		if (direct) {
			return direct;
		}
		// The sessions model namespaces the protocol session URI with the local
		// agent-host scheme prefix: protocol `claude:/<id>` ↔ model
		// `agent-host-claude:/<id>` — client keys use the model form.
		const candidates = (uri: string): string[] => {
			const list = [uri, `${LOCAL_AGENT_HOST_SCHEME_PREFIX}${uri}`];
			try {
				list.push(URI.parse(uri).toString(), URI.parse(`${LOCAL_AGENT_HOST_SCHEME_PREFIX}${uri}`).toString());
			} catch {
				/* not a parseable URI — string candidates suffice */
			}
			return list;
		};
		for (const candidate of candidates(channel)) {
			if (this._clients.has(candidate)) {
				return candidate; // session-channel action
			}
		}
		const parsed = parseChatUri(channel);
		if (!parsed || parsed.chatId.startsWith('subagent')) {
			return undefined;
		}
		// Chat URIs no longer expose their owning session (upstream is moving them
		// to opaque ids). Until the state watch above maps the channel, match it
		// against the default chat URI each mirrored session would have minted.
		for (const key of this._clients.keys()) {
			const backend = this._watches.get(key)?.backend;
			if (backend && channel === buildDefaultChatUri(backend)) {
				return key;
			}
		}
		return undefined;
	}

	/** Route one connection action to the owning session's relay and map it to a relay event. */
	private _onAction(envelope: ActionEnvelope): void {
		const channel = envelope.channel.toString();
		const key = this._resolveActionKey(channel);
		if (!key) {
			// A chat action for a session we don't mirror YET (its client is created
			// once the model reports it in progress) — keep it so the first user turn
			// and any leading deltas can be replayed. Subagent chats are not mirrored.
			// Chats are either legacy minted URIs or opaque `ahp-chat:/<uuid>` ids.
			const parsed = parseChatUri(channel);
			const isMirrorableChat = (parsed !== undefined && !parsed.chatId.startsWith('subagent')) || getCanonicalOpaqueChatUuid(channel) !== undefined;
			if (isMirrorableChat) {
				this._bufferEarlyAction(envelope);
			}
			if (!this._unroutedLogged.has(channel)) {
				this._unroutedLogged.add(channel);
				this._logService.trace(`[celiador-relay] unrouted action channel ${channel} (${isMirrorableChat ? 'buffered' : 'ignored'}; clients: ${[...this._clients.keys()].join(', ') || 'none'})`);
			}
			return;
		}
		const client = this._clients.get(key);
		if (!client) {
			return;
		}
		// No `client.active` gate: the relay session is created asynchronously and a
		// fast run streams before the create round-trip finishes — the client
		// buffers events until the session exists, so nothing here may be dropped.
		const action = envelope.action;
		switch (action.type) {
			case ActionType.ChatTurnStarted: {
				// Mirror the user's turn so the phone transcript has the question, not
				// just the answer. Skip turns the phone itself sent — the daemon is the
				// single source of those (POST /:id/message logs them).
				const text = action.message?.text;
				if (typeof text === 'string' && text.length > 0) {
					const echo = this._phoneSentTexts.indexOf(text);
					if (echo >= 0) {
						this._phoneSentTexts.splice(echo, 1);
					} else {
						client.publish({ kind: 'message', role: 'user', text });
					}
				}
				break;
			}
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
		// The session state's chat list may be unpopulated — the default chat
		// channel is derivable from the session resource, so fall back to it
		// (built from the PROTOCOL uri: the model key carries the agent-host-
		// scheme prefix the protocol layer doesn't know).
		const watch = this._watches.get(key);
		const chatChannel = watch?.primary ?? buildDefaultChatUri(watch?.backend ?? this._backendSession(URI.parse(key)).toString());
		if (!text.trim()) {
			return;
		}
		const message = { text, origin: { kind: MessageKind.User } };
		// Remember the text so its ChatTurnStarted echo isn't re-published as a
		// user message (bounded — stale entries age out by position).
		this._phoneSentTexts.push(text);
		if (this._phoneSentTexts.length > 20) {
			this._phoneSentTexts.shift();
		}
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
			// Celiador: an agent task's run browses its own worktree, not the window's checkout.
			const root = getCeliadorTaskRun(key)?.worktree ?? this._workspaceService.getWorkspace().folders[0]?.uri;
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
	private async _handleGitCommand(key: string, kind: RelayGitKind, requestId: string, args: IRelayGitArgs): Promise<void> {
		const client = this._clients.get(key);
		if (!client) {
			return;
		}
		try {
			const result = await this._commandService.executeCommand<{ ok: boolean;[key: string]: unknown }>('celiador.relayGit', { kind, ...args, root: getCeliadorTaskRun(key)?.worktree?.fsPath }); // Celiador: a task run's own worktree
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
			this._backendToKey.delete(watch.backend);
			if (watch.chatChannels.size > 0) {
				for (const channel of watch.chatChannels) {
					this._chatChannelToKey.delete(channel);
				}
				// Drop pending approvals/questions that belonged to this session's chat channels.
				for (const [requestId, pending] of this._pendingApprovals) {
					if (watch.chatChannels.has(pending.chatChannel)) {
						this._pendingApprovals.delete(requestId);
					}
				}
				for (const [requestId, pending] of this._pendingQuestions) {
					if (watch.chatChannels.has(pending.chatChannel)) {
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
		this._earlyActions = [];
		super.dispose();
	}
}
