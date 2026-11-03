/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { IReference } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { mock } from '../../../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IAgentHostConnectionsService, IAgentHostSessionIdentity } from '../../../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IAgentHostService } from '../../../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionType } from '../../../../../../../platform/agentHost/common/state/sessionActions.js';
import { ActionEnvelope, StateAction } from '../../../../../../../platform/agentHost/common/state/protocol/actions.js';
import { MessageKind } from '../../../../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { SessionState, StateComponents } from '../../../../../../../platform/agentHost/common/state/sessionState.js';
import { TestInstantiationService } from '../../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../../../platform/telemetry/common/telemetryUtils.js';
import { IAgentSession } from '../../../../browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../../../browser/agentSessions/agentSessionsService.js';
import { CeliadorRelayBridge } from '../../../../browser/agentSessions/agentHost/celiadorRelayBridge.js';
import { CeliadorRelayClient, ICeliadorRelayClientOptions, IRelayEvent } from '../../../../browser/agentSessions/agentHost/celiadorRelayClient.js';
import { deleteCeliadorTaskRun, setCeliadorTaskRun } from '../../../../browser/agentSessions/agentHost/celiadorTaskRuns.js';
import { ChatSessionStatus } from '../../../../common/chatSessionsService.js';

/** Records what the bridge relays instead of talking to the daemon. */
class RecordingRelayClient extends CeliadorRelayClient {
	readonly starts: { readonly title: string; readonly taskId?: string; readonly mirrorKey?: string }[] = [];
	readonly events: IRelayEvent[] = [];
	resets = 0;
	private _started = false;

	override get active(): boolean {
		return this._started;
	}

	override async start(title: string, taskId?: string, mirrorKey?: string): Promise<void> {
		this.starts.push({ title, taskId, mirrorKey });
		this._started = true;
	}

	override publish(event: IRelayEvent): void {
		this.events.push(event);
	}

	override reset(): void {
		this.resets++;
		this._started = false;
	}
}

suite('CeliadorRelayBridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Model resource of a local Claude session, as the sessions model lists it. */
	const sessionResource = (id: string) => URI.parse(`agent-host-claude:/${id}`);
	/** The backend address the agent host uses for it (upstream's `ahp-session:/` scheme). */
	const backendSession = (id: string) => URI.parse(`ahp-session:/${id}`);
	const taskRunKeys: URI[] = [];

	teardown(() => {
		for (const key of taskRunKeys.splice(0)) {
			deleteCeliadorTaskRun(key);
		}
	});

	function setUp(initialSessions: IAgentSession[] = []) {
		let sessions = initialSessions;
		const onDidChangeSessions = store.add(new Emitter<void>());
		const onDidAction = store.add(new Emitter<ActionEnvelope>());
		const states = new Map<string, SessionState>();
		const subscribed: string[] = [];
		const clients: RecordingRelayClient[] = [];

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IAgentSessionsService, new class extends mock<IAgentSessionsService>() {
			override model = new class extends mock<IAgentSessionsService['model']>() {
				override onDidChangeSessions = onDidChangeSessions.event;
				override get sessions() { return sessions; }
				override getSession(resource: URI) { return sessions.find(session => session.resource.toString() === resource.toString()); }
			}();
		}());
		instantiationService.stub(IAgentHostService, new class extends mock<IAgentHostService>() {
			override onDidAction = onDidAction.event;
			override getSubscription<T>(_kind: StateComponents, resource: URI): IReference<IAgentSubscription<T>> {
				subscribed.push(resource.toString());
				const object = new class extends mock<IAgentSubscription<SessionState>>() {
					override get value() { return states.get(resource.toString()); }
					override onDidChange = Event.None;
				}();
				return { object: object as unknown as IAgentSubscription<T>, dispose: () => { } };
			}
		}());
		instantiationService.stub(IAgentHostConnectionsService, new class extends mock<IAgentHostConnectionsService>() {
			override resolveSessionResourceIdentity(resource: URI): IAgentHostSessionIdentity {
				return { connectionAuthority: 'local', backendSession: backendSession(resource.path.replace(/^\//, '')) };
			}
		}());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ITelemetryService, NullTelemetryService);

		class TestRelayBridge extends CeliadorRelayBridge {
			// Runs during the base constructor: only closure state, no own fields.
			protected override _newRelayClient(options: ICeliadorRelayClientOptions): CeliadorRelayClient {
				const client = new RecordingRelayClient(options);
				clients.push(client);
				return client;
			}
		}

		return {
			clients,
			subscribed,
			/** The session state the host advertises for a session: its chat channels. */
			advertise(id: string, defaultChat: string, ...peers: string[]) {
				states.set(backendSession(id).toString(), { defaultChat, chats: [defaultChat, ...peers].map(resource => ({ resource })) } as SessionState);
			},
			setSessions(next: IAgentSession[]) {
				sessions = next;
				onDidChangeSessions.fire();
			},
			fire(channel: string, action: StateAction) {
				onDidAction.fire({ channel, action, serverSeq: 0, origin: undefined });
			},
			createBridge: () => store.add(instantiationService.createInstance(TestRelayBridge)),
		};
	}

	function session(id: string, status: ChatSessionStatus, label = `Session ${id}`): IAgentSession {
		return { resource: sessionResource(id), providerType: 'agent-host-claude', status, label } as IAgentSession;
	}

	/** Marks a session as this window's task run, so it claims its mirror without the cross-window wait. */
	function asTaskRun(id: string, taskId: string) {
		const resource = sessionResource(id);
		taskRunKeys.push(resource);
		setCeliadorTaskRun(resource, { taskId, title: 'Task', branch: 'b', repoRoot: URI.file('/repo'), startedAt: 0 });
	}

	const opaqueChat = () => `ahp-chat:/${generateUuid()}`;
	const turnStarted = (text: string): StateAction => ({ type: ActionType.ChatTurnStarted, turnId: 't1', startedAt: '2026-11-03T00:00:00.000Z', message: { text, origin: { kind: MessageKind.User } } });
	const delta = (content: string): StateAction => ({ type: ActionType.ChatDelta, turnId: 't1', partId: 'p1', content });

	test('routes a session through its backend address and opaque chat channels', async () => {
		const harness = setUp();
		const chat = opaqueChat();
		const peerChat = opaqueChat();
		harness.advertise('s1', chat, peerChat);
		asTaskRun('s1', 'task-1');
		harness.createBridge();

		harness.setSessions([session('s1', ChatSessionStatus.InProgress, 'Fix the login bug')]);
		await timeout(0);
		harness.fire(chat, turnStarted('Fix the login bug'));
		harness.fire(chat, delta('Looking at auth.ts'));
		harness.fire(peerChat, delta('Peer chat reply'));
		harness.fire(opaqueChat(), delta('Some other session'));

		assert.deepStrictEqual({
			subscribed: harness.subscribed,
			clients: harness.clients.map(client => ({ starts: client.starts, events: client.events })),
		}, {
			subscribed: ['ahp-session:/s1'],
			clients: [{
				starts: [{ title: 'Fix the login bug', taskId: 'task-1', mirrorKey: 'ahp-session:/s1' }],
				events: [
					{ kind: 'state', state: 'running' },
					{ kind: 'message', role: 'user', text: 'Fix the login bug' },
					{ kind: 'delta', text: 'Looking at auth.ts' },
					{ kind: 'delta', text: 'Peer chat reply' },
				],
			}],
		});
	});

	test('mirrors a session already running when the bridge starts, with the first turn it sent before being claimed', () => runWithFakedTimers({}, async () => {
		const harness = setUp([
			session('running', ChatSessionStatus.InProgress),
			session('finished', ChatSessionStatus.Completed),
		]);
		const chat = opaqueChat();
		harness.advertise('running', chat);
		harness.advertise('finished', opaqueChat());
		harness.createBridge();

		// Not a task run of this window: the claim waits for other windows first,
		// and the turn streamed meanwhile is buffered rather than dropped.
		harness.fire(chat, turnStarted('Add a dark mode'));
		const claimedEarly = harness.clients.length;
		await timeout(1_500);
		harness.fire(chat, delta('Sure'));

		assert.deepStrictEqual({
			claimedEarly,
			subscribed: harness.subscribed,
			clients: harness.clients.map(client => ({ mirrorKey: client.starts[0]?.mirrorKey, events: client.events })),
		}, {
			claimedEarly: 0,
			subscribed: ['ahp-session:/running'],
			clients: [{
				mirrorKey: 'ahp-session:/running',
				events: [
					{ kind: 'message', role: 'user', text: 'Add a dark mode' },
					{ kind: 'state', state: 'running' },
					{ kind: 'delta', text: 'Sure' },
				],
			}],
		});
	}));

	test('keeps one relay session through completion and a follow-up, and creates none after the session leaves', async () => {
		const harness = setUp();
		const chat = opaqueChat();
		harness.advertise('s1', chat);
		asTaskRun('s1', 'task-1');
		harness.createBridge();

		harness.setSessions([session('s1', ChatSessionStatus.InProgress)]);
		await timeout(0);
		harness.setSessions([session('s1', ChatSessionStatus.Completed)]);
		harness.setSessions([session('s1', ChatSessionStatus.Completed)]);
		harness.setSessions([session('s1', ChatSessionStatus.InProgress)]);
		harness.setSessions([session('s1', ChatSessionStatus.Completed)]);
		harness.setSessions([]);
		harness.fire(chat, delta('After removal'));
		harness.setSessions([]);

		assert.deepStrictEqual(harness.clients.map(client => ({ starts: client.starts.length, resets: client.resets, events: client.events })), [{
			starts: 1,
			resets: 1,
			events: [
				{ kind: 'state', state: 'running' },
				{ kind: 'done' },
				{ kind: 'state', state: 'done' },
				{ kind: 'state', state: 'running' },
				{ kind: 'done' },
				{ kind: 'state', state: 'done' },
			],
		}]);
	});
});
