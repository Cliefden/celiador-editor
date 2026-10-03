/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IReference } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { ActionEnvelope } from '../../../../../../platform/agentHost/common/state/protocol/actions.js';
import { SessionState, StateComponents } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { ChatSessionStatus } from '../../../common/chatSessionsService.js';
import { isAgentHostTarget } from '../agentSessions.js';
import { IAgentSessionsService } from '../agentSessionsService.js';
import { CeliadorRelayClient } from './celiadorRelayClient.js';

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

	/** sessionResource.toString() → the relay client mirroring it. */
	private readonly _clients = new Map<string, CeliadorRelayClient>();
	/** sessionResource.toString() → last published status (de-dupes repeats). */
	private readonly _lastStatus = new Map<string, ChatSessionStatus>();
	/** sessionResource.toString() → its session-state subscription + resolved default chat channel. */
	private readonly _watches = new Map<string, { readonly ref: IReference<IAgentSubscription<SessionState>>; readonly store: DisposableStore; chatChannel: string | undefined }>();
	/** chat channel URI string → owning sessionResource.toString() (routes action events). */
	private readonly _chatChannelToKey = new Map<string, string>();

	constructor(
		@IAgentSessionsService private readonly _sessionsService: IAgentSessionsService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IChatService private readonly _chatService: IChatService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
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
			const terminal = session.status === ChatSessionStatus.Completed || session.status === ChatSessionStatus.Failed;
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

			this._publishStatus(key, session.status, client);
			if (terminal) {
				// Terminal status published; flush + close this session's relay.
				this._disposeClient(key);
			}
		}
	}

	private _createClient(key: string, resource: URI): CeliadorRelayClient {
		const client = new CeliadorRelayClient({
			getUrl: () => this._daemonUrl(),
			getToken: () => this._token(),
			log: message => this._logService.trace(`[celiador-relay] ${message}`),
			onCancel: () => { void this._chatService.cancelCurrentRequestForSession(resource, 'celiador-phone'); },
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
				client.publish({ kind: 'tool', callId: action.toolCallId, name: action.toolName, input: {} });
				break;
			case ActionType.ChatActivityChanged:
				if (action.activity && action.activity.length > 0) {
					client.publish({ kind: 'activity', text: action.activity });
				}
				break;
		}
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
				client.publish({ kind: 'done' });
				break;
			case ChatSessionStatus.Failed:
				client.publish({ kind: 'error', message: 'The agent run failed.' });
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
		super.dispose();
	}
}
