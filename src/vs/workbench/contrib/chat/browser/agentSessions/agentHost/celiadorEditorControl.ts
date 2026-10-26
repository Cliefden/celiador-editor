/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { ClaudeSessionConfigKey } from '../../../../../../platform/agentHost/common/claudeSessionConfigKeys.js';
import { SessionConfigKey } from '../../../../../../platform/agentHost/common/sessionConfigKeys.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { ChatSessionStatus, SessionType } from '../../../common/chatSessionsService.js';
import { ChatSessionPosition, getResourceForNewChatSession, openChatSession } from '../../chatSessions/chatSessions.contribution.js';
import { openSessionByResource } from '../agentSessionsOpener.js';
import { IAgentSessionsService } from '../agentSessionsService.js';
import { getLocalAgentHostSessionProvider } from './agentHostSessionUri.js';
import { IAgentHostUntitledProvisionalSessionService } from './agentHostUntitledProvisionalSessionService.js';
import { celiadorPickedUpComment, celiadorTaskRunEntries, findCeliadorTaskRun, parseCeliadorTaskRuns, serializeCeliadorTaskRuns, setCeliadorTaskRun, type ICeliadorTaskRun } from './celiadorTaskRuns.js';
import { findOpenRepos, type ICeliadorOpenRepo } from './celiadorWorkspacePresence.js';

/**
 * Celiador: how much an agent task run may do without asking. Tasks run while
 * you are away, so the default is Claude's `auto` mode — it decides per tool
 * call, approving the routine ones (reads, lint, tests, a commit on the task's
 * own branch) and asking for the risky ones — which keeps the phone's queue to
 * real questions and finished pull requests rather than a tap per command.
 */
const TASK_PERMISSION_MODE_SETTING = 'celiador.agentTasks.permissionMode';
/** Celiador: comment on the GitHub issue when its run starts (the plan's "picked up" comment). */
const TASK_ISSUE_COMMENT_SETTING = 'celiador.agentTasks.issueComment';
/** Celiador: opt-in "made with Celiador" line on agent pull requests. */
const TASK_ATTRIBUTION_SETTING = 'celiador.agentTasks.attribution';
/** Celiador: this workspace's agent task run records (see {@link ICeliadorTaskRun}). */
const TASK_RUNS_STORAGE_KEY = 'celiador.agentTasks.runs';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'celiador',
	title: localize('celiador.configuration.title', "Celiador"),
	properties: {
		[TASK_PERMISSION_MODE_SETTING]: {
			type: 'string',
			enum: ['auto', 'default'],
			enumDescriptions: [
				localize('celiador.agentTasks.permissionMode.auto', "Claude decides per tool call: routine commands run, risky ones ask you on the phone."),
				localize('celiador.agentTasks.permissionMode.default', "Every terminal command asks for approval, as in a regular chat."),
			],
			default: 'auto',
			description: localize('celiador.agentTasks.permissionMode', "How much an agent task (a queued GitHub issue run in its own worktree) may do without asking."),
		},
		[TASK_ISSUE_COMMENT_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('celiador.agentTasks.issueComment', "When a queued GitHub issue starts running, post a short comment on it (with your GitHub sign-in) saying an agent picked it up and will open a pull request."),
		},
		[TASK_ATTRIBUTION_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('celiador.agentTasks.attribution', "Add a line to pull requests opened by agent tasks saying they were made with Celiador."),
		},
	},
});

type PhoneRunClassification = {
	seeded: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the phone sent a first prompt with the run request or opened an idle chat.' };
	owner: 'celiador';
	comment: 'The companion phone started a run on this editor via "Run on your editor".';
};
/** A `start-task` command from the daemon's agent task queue. */
interface ITaskCommand {
	readonly kind: 'start-task';
	readonly taskId?: string;
	readonly remoteUrl?: string;
	readonly name?: string;
	readonly branch?: string;
	readonly prompt?: string;
	readonly title?: string;
	readonly issue?: { readonly number: number; readonly url: string };
	/** The daemon already commented on the issue (as the Celiador GitHub App). */
	readonly commented?: boolean;
}

type PhoneRunEvent = {
	seeded: boolean;
};

/** The pull request numbers the celiador-ai extension reads off GitHub for a task's PR. */
interface ITaskPullRequest {
	readonly number: number;
	readonly additions?: number;
	readonly deletions?: number;
	readonly changedFiles?: number;
}

/** What `POST /api/tasks/:id/status` accepts from the editor (agents UI contract §2). */
interface ITaskStatusReport {
	readonly state: 'running' | 'pr-open' | 'failed';
	readonly prUrl?: string;
	readonly error?: string;
	readonly pr?: ITaskPullRequest;
}

/** What `celiador.taskRunInfo` returns to the celiador-ai extension's Agents view. */
interface ICeliadorTaskRunInfo {
	readonly taskId: string;
	readonly title: string;
	readonly branch: string;
	readonly repoRoot: string;
	readonly worktree?: string;
	readonly sessionResource: string;
	readonly finished: boolean;
	readonly prUrl?: string;
	readonly startedAt: number;
}

/**
 * Celiador: the editor end of "Run on your editor". The companion phone asks the
 * daemon to start a run on a repo it already has open (POST /api/presence/requests);
 * the daemon fans that out over a per-user control stream. This contribution holds
 * that stream open and, when a `start-run` arrives for a repo THIS window has open,
 * opens a local agent-host (Claude) session seeded with the prompt — which the
 * relay bridge then mirrors back to the phone.
 *
 * The point: no clone and no credentials. The agent runs on the local working copy,
 * using the real local runner, exactly as if you'd started it at the keyboard. A
 * request whose repo isn't open in this window is ignored (another window — or none
 * — has it; the daemon delivered it to every signed-in editor).
 */
export class CeliadorEditorControl extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.celiadorEditorControl';

	/** Must match the auth provider id registered by the celiador-ai extension. */
	private static readonly AUTH_PROVIDER_ID = 'celiador';
	private static readonly FALLBACK_DAEMON_URL = 'https://celiador.ai';
	/** Reconnect/poll backoff when the stream drops or we're signed out. */
	private static readonly RECONNECT_MS = 3_000;
	/** The in-place action that opens a local agent-host Claude session (+ prompt). */
	private static readonly OPEN_SESSION_COMMAND = `workbench.action.chat.openNewChatSessionInPlace.${SessionType.AgentHostClaude}`;

	private readonly _cts = this._register(new CancellationTokenSource());
	/** Aborts the in-flight control stream fetch on dispose. */
	private readonly _abort = new AbortController();
	/** Request ids already acted on, so a reconnect can't double-start a run. */
	private readonly _handled = new Set<string>();
	/** This computer's name as the celiador-ai extension reports it (asked once). */
	private _machine: string | undefined;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostUntitledProvisionalSessionService private readonly _provisionalSessions: IAgentHostUntitledProvisionalSessionService,
		@IAgentSessionsService private readonly _sessionsService: IAgentSessionsService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._register(toDisposable(() => this._abort.abort()));
		// Agent tasks: the runs this workspace started survive a reload, so a
		// finished run's follow-ups, merge and diffs keep targeting its worktree.
		this._restoreTaskRuns();
		this._register(this._registerTaskCommands());
		// Agent tasks: notice when a task's run finishes, then open its pull request.
		this._register(this._sessionsService.model.onDidChangeSessions(() => this._checkTaskRuns()));
		void this._loop();
	}

	private _daemonUrl(): string {
		return (this._productService.celiadorDaemonUrl ?? CeliadorEditorControl.FALLBACK_DAEMON_URL).replace(/\/+$/, '');
	}

	private async _token(): Promise<string | undefined> {
		try {
			const sessions = await this._authenticationService.getSessions(CeliadorEditorControl.AUTH_PROVIDER_ID, []);
			return sessions[0]?.accessToken;
		} catch {
			return undefined;
		}
	}

	/** Hold the control stream open, reconnecting with backoff; dormant while signed out. */
	private async _loop(): Promise<void> {
		const token = this._cts.token;
		while (!token.isCancellationRequested) {
			const auth = await this._token();
			if (!auth) {
				await this._backoff();
				continue;
			}
			try {
				const res = await fetch(`${this._daemonUrl()}/api/presence/commands`, {
					headers: { Authorization: `Bearer ${auth}` },
					signal: this._abort.signal,
				});
				if (!res.ok || !res.body) {
					await this._backoff();
					continue;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = '';
				while (!token.isCancellationRequested) {
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
						if (payload) {
							void this._handle(payload);
						}
					}
				}
			} catch (e) {
				this._logService.trace(`[celiador-control] stream error: ${e}`);
			}
			await this._backoff();
		}
	}

	private async _handle(payload: string): Promise<void> {
		let cmd: { kind?: string; requestId?: string; remoteUrl?: string; prompt?: string; name?: string };
		try {
			cmd = JSON.parse(payload);
		} catch {
			return;
		}
		if (cmd.kind === 'start-task') {
			return this._startTask(cmd as ITaskCommand);
		}
		if (cmd.kind !== 'start-run' || !cmd.requestId || !cmd.remoteUrl) {
			return;
		}
		if (this._handled.has(cmd.requestId)) {
			return;
		}
		// Only this window should act, and only if it actually has the repo open.
		const repo = await this._repoForRemote(cmd.remoteUrl);
		if (!repo) {
			return;
		}
		this._handled.add(cmd.requestId);
		try {
			// With a prompt, seed the first turn; without one, open an idle session so
			// the phone lands in a live chat and types the first message itself.
			const sendOptions = cmd.prompt && cmd.prompt.trim() ? { prompt: cmd.prompt } : undefined;
			if (repo.nested) {
				await this._openSessionIn(repo.folder, sendOptions);
			} else {
				await this._commandService.executeCommand(CeliadorEditorControl.OPEN_SESSION_COMMAND, 'sidebar', sendOptions);
			}
			this._logService.trace(`[celiador-control] started a run for ${cmd.name ?? cmd.remoteUrl}`);
			this._telemetryService.publicLog2<PhoneRunEvent, PhoneRunClassification>('celiador/phoneRun', { seeded: !!sendOptions });
		} catch (e) {
			this._handled.delete(cmd.requestId);
			this._logService.trace(`[celiador-control] failed to start a run: ${e}`);
		}
	}

	/** The checkout reachable from this window whose origin remote is `remoteUrl`. */
	private async _repoForRemote(remoteUrl: string): Promise<ICeliadorOpenRepo | undefined> {
		const repos = await findOpenRepos(this._workspaceService, this._fileService);
		return repos.find(r => r.remoteUrl.toLowerCase() === remoteUrl.toLowerCase());
	}

	/**
	 * Open a local agent-host session whose working directory is `folder` — a repo
	 * nested inside a workspace folder, which the in-place command (it uses the
	 * window's default folder) can't target.
	 */
	private async _openSessionIn(folder: URI, sendOptions: { prompt: string } | undefined): Promise<void> {
		const openOptions = { type: SessionType.AgentHostClaude, position: ChatSessionPosition.Sidebar, displayName: 'Chat' };
		const draft = getResourceForNewChatSession(openOptions);
		const provider = getLocalAgentHostSessionProvider(draft);
		if (!provider) {
			throw new Error('the local agent host is not available');
		}
		if (!await this._provisionalSessions.applyConfigChange(draft, provider, folder, {})) {
			throw new Error('the repository folder is not trusted, or the agent host is unavailable');
		}
		await this._instantiationService.invokeFunction(accessor => openChatSession(accessor, { ...openOptions, sessionResource: draft }, sendOptions));
	}

	private _backoff(): Promise<void> {
		return new Promise<void>(resolve => {
			const timer = setTimeout(resolve, CeliadorEditorControl.RECONNECT_MS);
			this._cts.token.onCancellationRequested(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	// --- Agent tasks (the agent-first queue) -----------------------------------

	/** Load the run records this workspace kept (see {@link _saveTaskRuns}). */
	private _restoreTaskRuns(): void {
		for (const [key, run] of parseCeliadorTaskRuns(this._storageService.get(TASK_RUNS_STORAGE_KEY, StorageScope.WORKSPACE))) {
			setCeliadorTaskRun(URI.parse(key), run);
			this._handled.add(run.taskId);
		}
	}

	/** Persist the run records (capped) so a window reload keeps targeting each run's worktree. */
	private _saveTaskRuns(): void {
		this._storageService.store(TASK_RUNS_STORAGE_KEY, serializeCeliadorTaskRuns(celiadorTaskRunEntries()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/**
	 * Commands the celiador-ai extension's Agents view calls: where a task's run
	 * lives (`celiador.taskRunInfo`), and focusing its chat (`celiador.openTaskSession`).
	 */
	private _registerTaskCommands(): IDisposable {
		const info = CommandsRegistry.registerCommand('celiador.taskRunInfo', async (_accessor, taskId: unknown): Promise<ICeliadorTaskRunInfo | undefined> => {
			if (typeof taskId !== 'string') {
				return undefined;
			}
			const found = findCeliadorTaskRun(taskId);
			if (!found) {
				return undefined;
			}
			const { run, keys } = found;
			const worktree = run.worktree ?? await this._resolveWorktree(run);
			return {
				taskId: run.taskId,
				title: run.title,
				branch: run.branch,
				repoRoot: run.repoRoot.fsPath,
				worktree: worktree?.fsPath,
				sessionResource: this._liveSessionKey(keys) ?? keys[keys.length - 1],
				finished: run.finished === true,
				prUrl: run.prUrl,
				startedAt: run.startedAt,
			};
		});
		const open = CommandsRegistry.registerCommand('celiador.openTaskSession', async (accessor, taskId: unknown): Promise<boolean> => {
			const found = typeof taskId === 'string' ? findCeliadorTaskRun(taskId) : undefined;
			const key = found && this._liveSessionKey(found.keys);
			if (!key) {
				return false;
			}
			await openSessionByResource(accessor, URI.parse(key));
			return true;
		});
		return toDisposable(() => {
			info.dispose();
			open.dispose();
		});
	}

	/** The one of a run's recorded resources that the sessions model knows. */
	private _liveSessionKey(keys: readonly string[]): string | undefined {
		const sessions = this._sessionsService.model.sessions;
		return keys.find(key => sessions.some(s => s.resource.toString() === key));
	}

	/** This computer's name and the repository's default branch, from the celiador-ai extension. */
	private async _taskContext(repoRoot?: URI): Promise<{ machine?: string; defaultBranch?: string }> {
		try {
			const result = await this._commandService.executeCommand<{ machine?: string; defaultBranch?: string }>('celiador.taskContext', { repoRoot: repoRoot?.fsPath });
			return result ?? {};
		} catch {
			return {};
		}
	}

	private async _machineName(): Promise<string | undefined> {
		// Not cached while unknown: the extension may not have activated yet.
		this._machine ??= (await this._taskContext()).machine;
		return this._machine;
	}

	/**
	 * Run a queued agent task: a new local agent-host session in its own git
	 * worktree on the task's branch, seeded with the task's prompt. The run is
	 * recorded so the relay bridge links it to the task on the phone, and so
	 * {@link _checkTaskRuns} can open the pull request when it finishes.
	 */
	private async _startTask(cmd: ITaskCommand): Promise<void> {
		if (!cmd.taskId || !cmd.remoteUrl || !cmd.branch || !cmd.prompt || this._handled.has(cmd.taskId) || findCeliadorTaskRun(cmd.taskId)) {
			return;
		}
		const folder = (await this._repoForRemote(cmd.remoteUrl))?.folder;
		if (!folder) {
			return; // another window (or none) has this repo
		}
		this._handled.add(cmd.taskId);
		try {
			const type = SessionType.AgentHostClaude;
			const openOptions = { type, position: ChatSessionPosition.Sidebar, displayName: 'Chat' };
			const draft = getResourceForNewChatSession(openOptions);
			const provider = getLocalAgentHostSessionProvider(draft);
			if (!provider) {
				throw new Error('the local agent host is not available');
			}
			// Worktree isolation on the task's exact branch; the host creates the
			// worktree on the first send and falls back to a generated name if taken.
			// Task runs are unattended: Claude's `auto` mode approves routine tool
			// calls itself and asks (on the phone) only for the risky ones.
			const permissionMode = this._configurationService.getValue<string>(TASK_PERMISSION_MODE_SETTING) === 'default' ? 'default' : 'auto';
			const backend = await this._provisionalSessions.applyConfigChange(draft, provider, folder, {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.WorktreeBranchName]: cmd.branch,
				[ClaudeSessionConfigKey.PermissionMode]: permissionMode,
			});
			if (!backend) {
				throw new Error('the repository folder is not trusted, or the agent host is unavailable');
			}
			const run: ICeliadorTaskRun = { taskId: cmd.taskId, title: cmd.title ?? cmd.branch, branch: cmd.branch, issue: cmd.issue, repoRoot: folder, startedAt: Date.now() };
			// Record against the draft first: the bridge may mirror the session before openChatSession returns.
			setCeliadorTaskRun(draft, run);
			const opened = await this._instantiationService.invokeFunction(accessor => openChatSession(accessor, { ...openOptions, sessionResource: draft }, { prompt: cmd.prompt! }));
			if (opened && opened.toString() !== draft.toString()) {
				setCeliadorTaskRun(opened, run);
			}
			this._saveTaskRuns();
			this._logService.info(`[celiador-control] task ${cmd.taskId} running on ${cmd.branch}`);
			await this._reportTask(cmd.taskId, { state: 'running' });
			// The issue's "picked up" comment: best-effort, through the extension's
			// GitHub sign-in (or gh), so watchers of the issue see it is in motion.
			if (cmd.issue && !cmd.commented && this._configurationService.getValue<boolean>(TASK_ISSUE_COMMENT_SETTING) !== false) {
				const context = await this._taskContext(folder);
				const body = celiadorPickedUpComment({ machine: context.machine, branch: cmd.branch, baseBranch: context.defaultBranch, taskId: cmd.taskId, openBaseUrl: this._daemonUrl() });
				void this._commandService.executeCommand<{ ok: boolean; error?: string }>('celiador.commentOnIssue', { remoteUrl: cmd.remoteUrl, number: cmd.issue.number, body })
					.then(result => {
						if (!result?.ok) {
							this._logService.info(`[celiador-control] task ${cmd.taskId}: no issue comment (${result?.error ?? 'unavailable'})`);
						}
					}, e => this._logService.trace(`[celiador-control] issue comment failed: ${e}`));
			}
		} catch (e) {
			this._handled.delete(cmd.taskId);
			const message = e instanceof Error ? e.message : String(e);
			this._logService.warn(`[celiador-control] task ${cmd.taskId} failed to start: ${message}`);
			await this._reportTask(cmd.taskId, { state: 'failed', error: `Couldn't start the run: ${message}` });
		}
	}

	/**
	 * A task run's turn finished: push its branch and open (or refresh) the pull
	 * request, once per turn. A finished run whose session starts another turn — a
	 * follow-up from the phone, the Agents view or the chat — is reported running
	 * again, and finished again (more commits on the same PR) when that turn ends.
	 */
	private _checkTaskRuns(): void {
		for (const [key, run] of celiadorTaskRunEntries()) {
			const session = this._sessionsService.model.sessions.find(s => s.resource.toString() === key);
			if (!session) {
				continue;
			}
			if (run.finished) {
				if (session.status === ChatSessionStatus.InProgress || session.status === ChatSessionStatus.NeedsInput) {
					run.finished = false;
					this._saveTaskRuns();
					this._logService.info(`[celiador-control] task ${run.taskId} is running a follow-up`);
					void this._reportTask(run.taskId, { state: 'running' });
				}
				continue;
			}
			if (!run.worktree) {
				void this._resolveWorktree(run);
			}
			if (session.status === ChatSessionStatus.Completed) {
				run.finished = true;
				this._saveTaskRuns();
				void this._finishTask(run);
			} else if (session.status === ChatSessionStatus.Failed) {
				run.finished = true;
				this._saveTaskRuns();
				void this._reportTask(run.taskId, { state: 'failed', error: 'The agent run failed.' });
			}
		}
	}

	private async _resolveWorktree(run: ICeliadorTaskRun): Promise<URI | undefined> {
		const path = await this._commandService.executeCommand<string | undefined>('celiador.taskWorktree', { repoRoot: run.repoRoot.fsPath, branch: run.branch }).catch(() => undefined);
		if (path && run.worktree?.fsPath !== path) {
			run.worktree = URI.file(path);
			this._saveTaskRuns();
		}
		return run.worktree;
	}

	/**
	 * Commit what the turn left, push, and open the pull request — or, after a
	 * follow-up, find the one already open — then report `pr-open` with fresh PR
	 * numbers. The run record is kept so later turns and merges find the worktree.
	 */
	private async _finishTask(run: ICeliadorTaskRun): Promise<void> {
		try {
			const worktree = run.worktree ?? await this._resolveWorktree(run);
			if (!worktree) {
				throw new Error(`couldn't find the run's worktree for branch ${run.branch} (was the name taken?)`);
			}
			const result = await this._commandService.executeCommand<{ ok: boolean; url?: string; error?: string; pr?: ITaskPullRequest }>('celiador.finishTask', { root: worktree.fsPath, title: run.title, issue: run.issue, attribution: this._configurationService.getValue<boolean>(TASK_ATTRIBUTION_SETTING) === true });
			if (!result?.ok || !result.url) {
				throw new Error(result?.error ?? 'opening the pull request failed');
			}
			run.prUrl = result.url;
			this._saveTaskRuns();
			await this._reportTask(run.taskId, { state: 'pr-open', prUrl: result.url, pr: result.pr });
			this._logService.info(`[celiador-control] task ${run.taskId} opened ${result.url}`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (run.prUrl) {
				// A follow-up that couldn't push more: the pull request it already has still
				// stands, but say why the new work isn't on it rather than look up to date.
				this._logService.warn(`[celiador-control] task ${run.taskId}: follow-up not pushed: ${message}`);
				await this._reportTask(run.taskId, { state: 'pr-open', prUrl: run.prUrl, error: `The follow-up wasn't pushed: ${message}` });
				return;
			}
			this._logService.warn(`[celiador-control] task ${run.taskId} could not open its pull request: ${message}`);
			await this._reportTask(run.taskId, { state: 'failed', error: message });
		}
	}

	/** Tell the daemon how a task is doing (with this computer's name); best-effort. */
	private async _reportTask(taskId: string, status: ITaskStatusReport): Promise<void> {
		const auth = await this._token();
		if (!auth) {
			return;
		}
		const machine = await this._machineName();
		try {
			await fetch(`${this._daemonUrl()}/api/tasks/${encodeURIComponent(taskId)}/status`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...status, ...(machine ? { machine } : {}) }),
			});
		} catch (e) {
			this._logService.trace(`[celiador-control] task status report failed: ${e}`);
		}
	}

}
