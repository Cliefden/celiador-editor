/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { SessionType } from '../../../common/chatSessionsService.js';
import { normalizeToHttps, parseRemoteUrl } from './celiadorWorkspacePresence.js';

type PhoneRunClassification = {
	seeded: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the phone sent a first prompt with the run request or opened an idle chat.' };
	owner: 'celiador';
	comment: 'The companion phone started a run on this editor via "Run on your editor".';
};
type PhoneRunEvent = {
	seeded: boolean;
};

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

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();
		this._register(toDisposable(() => this._abort.abort()));
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
		if (cmd.kind !== 'start-run' || !cmd.requestId || !cmd.remoteUrl) {
			return;
		}
		if (this._handled.has(cmd.requestId)) {
			return;
		}
		// Only this window should act, and only if it actually has the repo open.
		const open = await this._openRemotes();
		if (!open.has(cmd.remoteUrl)) {
			return;
		}
		this._handled.add(cmd.requestId);
		try {
			// With a prompt, seed the first turn; without one, open an idle session so
			// the phone lands in a live chat and types the first message itself.
			const sendOptions = cmd.prompt && cmd.prompt.trim() ? { prompt: cmd.prompt } : undefined;
			await this._commandService.executeCommand(CeliadorEditorControl.OPEN_SESSION_COMMAND, 'sidebar', sendOptions);
			this._logService.trace(`[celiador-control] started a run for ${cmd.name ?? cmd.remoteUrl}`);
			this._telemetryService.publicLog2<PhoneRunEvent, PhoneRunClassification>('celiador/phoneRun', { seeded: !!sendOptions });
		} catch (e) {
			this._handled.delete(cmd.requestId);
			this._logService.trace(`[celiador-control] failed to start a run: ${e}`);
		}
	}

	/** The https-normalised origin remotes of the folders open in this window. */
	private async _openRemotes(): Promise<Set<string>> {
		const remotes = new Set<string>();
		for (const folder of this._workspaceService.getWorkspace().folders) {
			const remote = await this._folderRemote(folder.uri);
			if (remote) {
				remotes.add(remote);
			}
		}
		return remotes;
	}

	private async _folderRemote(root: URI): Promise<string | undefined> {
		try {
			const configUri = joinPath(root, '.git', 'config');
			if (!(await this._fileService.exists(configUri))) {
				return undefined;
			}
			const config = (await this._fileService.readFile(configUri)).value.toString();
			const remote = parseRemoteUrl(config);
			return remote ? normalizeToHttps(remote) : undefined;
		} catch {
			return undefined;
		}
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
}
