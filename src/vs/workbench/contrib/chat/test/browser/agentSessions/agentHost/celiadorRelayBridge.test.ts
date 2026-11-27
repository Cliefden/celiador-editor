/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { VSBuffer, VSBufferReadable, VSBufferReadableStream } from '../../../../../../../base/common/buffer.js';
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
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, IFileContent, IFileService, IFileStat, IFileStatWithMetadata, IFileStatWithPartialMetadata, IResolveFileOptions, IResolveMetadataFileOptions } from '../../../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../../../platform/log/common/log.js';
import { INotification, INotificationHandle, INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../platform/notification/test/common/testNotificationService.js';
import { ITelemetryService } from '../../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../../../platform/telemetry/common/telemetryUtils.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../../../platform/workspace/common/workspaceTrust.js';
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

	/** requestId → resolves with the `fs.result` the bridge publishes for it. */
	readonly answers = new Map<string, (event: IRelayEvent) => void>();

	constructor(readonly options: ICeliadorRelayClientOptions) {
		super(options);
	}

	override get active(): boolean {
		return this._started;
	}

	override async start(title: string, taskId?: string, mirrorKey?: string): Promise<void> {
		this.starts.push({ title, taskId, mirrorKey });
		this._started = true;
	}

	override publish(event: IRelayEvent): void {
		this.events.push(event);
		if (typeof event.requestId === 'string') {
			this.answers.get(event.requestId)?.(event);
		}
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
	/** The options the bridge built each relay client with (its phone-command callbacks). */
	const clientOptions = new Map<CeliadorRelayClient, ICeliadorRelayClientOptions>();

	teardown(() => {
		for (const key of taskRunKeys.splice(0)) {
			deleteCeliadorTaskRun(key);
		}
		clientOptions.clear();
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
			override dispatch(): void { }
		}());
		instantiationService.stub(IAgentHostConnectionsService, new class extends mock<IAgentHostConnectionsService>() {
			override resolveSessionResourceIdentity(resource: URI): IAgentHostSessionIdentity {
				return { connectionAuthority: 'local', backendSession: backendSession(resource.path.replace(/^\//, '')) };
			}
		}());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ITelemetryService, NullTelemetryService);

		// The workspace the phone's file commands act on: path → file contents, a
		// folder (`dir`), or a symbolic link (`link`).
		const files = new Map<string, string | 'dir' | 'link'>([['/ws', 'dir']]);
		const notifications: string[] = [];
		const gitCommands: unknown[] = [];
		let trusted = true;
		const configuration = new TestConfigurationService();
		const notFound = (resource: URI) => createFileSystemProviderError(`not found: ${resource.path}`, FileSystemProviderErrorCode.FileNotFound);
		instantiationService.stub(IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace { return { id: 'ws', uri: URI.file('/ws'), folders: [{ uri: URI.file('/ws'), name: 'ws', index: 0, toResource: (path: string) => URI.file(`/ws/${path}`) }] }; }
		}());
		instantiationService.stub(IWorkspaceTrustManagementService, new class extends mock<IWorkspaceTrustManagementService>() {
			override isWorkspaceTrusted() { return trusted; }
		}());
		instantiationService.stub(IConfigurationService, configuration);
		instantiationService.stub(INotificationService, new class extends TestNotificationService {
			override notify(notification: INotification): INotificationHandle {
				notifications.push(String(notification.message));
				return super.notify(notification);
			}
		}());
		instantiationService.stub(ICommandService, new class extends mock<ICommandService>() {
			override async executeCommand<R>(_id: string, args: unknown): Promise<R> {
				gitCommands.push(args);
				return { ok: true } as R;
			}
		}());
		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override async stat(resource: URI): Promise<IFileStatWithPartialMetadata> {
				const entry = files.get(resource.path);
				if (entry === undefined) {
					throw notFound(resource);
				}
				return { resource, name: resource.path, isFile: entry !== 'dir', isDirectory: entry === 'dir', isSymbolicLink: entry === 'link' } as IFileStatWithPartialMetadata;
			}
			override resolve(resource: URI, options: IResolveMetadataFileOptions): Promise<IFileStatWithMetadata>;
			override resolve(resource: URI, options?: IResolveFileOptions): Promise<IFileStat>;
			override async resolve(resource: URI): Promise<IFileStat> {
				const children = [...files.keys()]
					.filter(path => path.startsWith(`${resource.path}/`) && !path.slice(resource.path.length + 1).includes('/'))
					.map(path => ({ name: path.slice(resource.path.length + 1), isDirectory: files.get(path) === 'dir', size: 1 }) as IFileStat);
				return { resource, name: resource.path, isFile: false, isDirectory: true, isSymbolicLink: false, children };
			}
			override async readFile(resource: URI): Promise<IFileContent> {
				const entry = files.get(resource.path);
				if (entry === undefined || entry === 'dir') {
					throw notFound(resource);
				}
				return { value: VSBuffer.fromString(entry) } as IFileContent;
			}
			override async writeFile(resource: URI, buffer: VSBuffer | VSBufferReadable | VSBufferReadableStream): Promise<IFileStatWithMetadata> {
				files.set(resource.path, (buffer as VSBuffer).toString());
				return await this.stat(resource) as IFileStatWithMetadata;
			}
		}());

		class TestRelayBridge extends CeliadorRelayBridge {
			// Runs during the base constructor: only closure state, no own fields.
			protected override _newRelayClient(options: ICeliadorRelayClientOptions): CeliadorRelayClient {
				const client = new RecordingRelayClient(options);
				clients.push(client);
				clientOptions.set(client, options);
				return client;
			}
		}

		return {
			clients,
			subscribed,
			files,
			notifications,
			gitCommands,
			configuration,
			setTrusted(value: boolean) { trusted = value; },
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

	test('hides the echo of a phone instruction only in the session the phone sent it to', async () => {
		const harness = setUp();
		const chat1 = opaqueChat();
		const chat2 = opaqueChat();
		harness.advertise('s1', chat1);
		harness.advertise('s2', chat2);
		asTaskRun('s1', 'task-1');
		asTaskRun('s2', 'task-2');
		harness.createBridge();

		harness.setSessions([session('s1', ChatSessionStatus.InProgress), session('s2', ChatSessionStatus.InProgress)]);
		await timeout(0);
		clientOptions.get(harness.clients[0])!.onInstruct!('Run the tests');
		harness.fire(chat1, turnStarted('Run the tests'));
		harness.fire(chat2, turnStarted('Run the tests'));

		assert.deepStrictEqual(harness.clients.map(client => client.events.filter(event => event.kind === 'message')), [
			[],
			[{ kind: 'message', role: 'user', text: 'Run the tests' }],
		]);
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

	suite('phone file commands', () => {

		/** A bridge mirroring one task-run session, and a way to send it phone commands and collect the answers. */
		async function phone() {
			const harness = setUp();
			harness.advertise('s1', opaqueChat());
			asTaskRun('s1', 'task-1');
			harness.createBridge();
			harness.setSessions([session('s1', ChatSessionStatus.InProgress)]);
			await timeout(0);
			const client = harness.clients[0];
			let next = 0;
			const send = async (kind: 'fs.list' | 'fs.read' | 'fs.write', path: string, content?: string) => {
				const requestId = `r${next++}`;
				const answered = new Promise<IRelayEvent>(resolve => client.answers.set(requestId, resolve));
				client.options.onFsCommand!(kind, requestId, path, content);
				const { kind: _kind, requestId: _id, ...result } = await answered;
				return result;
			};
			return { harness, client, send };
		}

		test('reads and writes workspace files but not git internals, configuration that runs code, symbolic links or escapes', async () => {
			const { harness, send } = await phone();
			harness.files.set('/ws/.git', 'dir');
			harness.files.set('/ws/.git/config', '[core]');
			harness.files.set('/ws/.vscode', 'dir');
			harness.files.set('/ws/src', 'dir');
			harness.files.set('/ws/src/a.ts', 'old');
			harness.files.set('/ws/secrets', 'link');

			const results = {
				list: await send('fs.list', ''),
				read: await send('fs.read', 'src/a.ts'),
				write: await send('fs.write', 'src/a.ts', 'new'),
				writeNew: await send('fs.write', 'src/new/b.ts', 'b'),
				readGit: await send('fs.read', '.git/config'),
				writeGit: await send('fs.write', '.git/hooks/pre-commit', 'x'),
				writeGitUpper: await send('fs.write', '.GIT/config', 'x'),
				writeTasks: await send('fs.write', '.vscode/tasks.json', '{}'),
				writeMcp: await send('fs.write', 'sub/.mcp.json', '{}'),
				readLink: await send('fs.read', 'secrets/id_rsa'),
				writeLink: await send('fs.write', 'secrets', 'x'),
				escape: await send('fs.read', 'src/../../etc/passwd'),
				backslash: await send('fs.write', 'src\\..\\..\\x', 'x'),
			};

			assert.deepStrictEqual({
				results,
				written: [harness.files.get('/ws/src/a.ts'), harness.files.get('/ws/src/new/b.ts'), harness.files.get('/ws/.git/config')],
				notifications: harness.notifications,
			}, {
				results: {
					list: { ok: true, entries: [{ name: '.vscode', type: 'dir', size: 1 }, { name: 'src', type: 'dir', size: 1 }, { name: 'secrets', type: 'file', size: 1 }] },
					read: { ok: true, content: 'old', encoding: 'utf8', truncated: false },
					write: { ok: true },
					writeNew: { ok: true },
					readGit: { ok: false, error: 'the phone cannot access this path' },
					writeGit: { ok: false, error: 'the phone cannot access this path' },
					writeGitUpper: { ok: false, error: 'the phone cannot access this path' },
					writeTasks: { ok: false, error: 'the phone cannot access this path' },
					writeMcp: { ok: false, error: 'the phone cannot access this path' },
					readLink: { ok: false, error: 'the phone cannot follow symbolic links' },
					writeLink: { ok: false, error: 'the phone cannot follow symbolic links' },
					escape: { ok: false, error: 'bad path' },
					backslash: { ok: false, error: 'bad path' },
				},
				written: ['new', 'b', '[core]'],
				notifications: ['Your phone saved src/a.ts.', 'Your phone saved src/new/b.ts.'],
			});
		});

		test('does nothing in an untrusted workspace, and only reads while phone writes are turned off', async () => {
			const { harness, client, send } = await phone();
			harness.files.set('/ws/a.ts', 'old');

			harness.setTrusted(false);
			const untrusted = [await send('fs.read', 'a.ts'), await send('fs.write', 'a.ts', 'new')];
			client.options.onGitCommand!('git.status', 'g0', {});
			harness.setTrusted(true);
			await harness.configuration.setUserConfiguration('celiador.phone.allowFileWrites', false);
			const writesOff = [await send('fs.read', 'a.ts'), await send('fs.write', 'a.ts', 'new')];
			client.options.onGitCommand!('git.revert', 'g1', { paths: ['a.ts'] });
			client.options.onGitCommand!('git.status', 'g2', {});
			await timeout(0);

			assert.deepStrictEqual({
				untrusted,
				writesOff,
				git: client.events.filter(event => typeof event.requestId === 'string' && event.requestId.startsWith('g')),
				gitCommands: harness.gitCommands,
				content: harness.files.get('/ws/a.ts'),
			}, {
				untrusted: [
					{ ok: false, error: 'this workspace is not trusted on the computer' },
					{ ok: false, error: 'this workspace is not trusted on the computer' },
				],
				writesOff: [
					{ ok: true, content: 'old', encoding: 'utf8', truncated: false },
					{ ok: false, error: 'changing files from the phone is turned off on the computer' },
				],
				git: [
					{ kind: 'fs.result', requestId: 'g0', ok: false, error: 'this workspace is not trusted on the computer' },
					{ kind: 'fs.result', requestId: 'g1', ok: false, error: 'changing files from the phone is turned off on the computer' },
					{ kind: 'fs.result', requestId: 'g2', ok: true },
				],
				gitCommands: [{ kind: 'git.status', root: undefined }],
				content: 'old',
			});
		});
	});
});
