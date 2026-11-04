/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { parseHooksJson, pathExists, readJsonFile } from '../../../../../../platform/agentPlugins/common/pluginParsers.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../../platform/workspace/common/workspaceTrust.js';

/**
 * Celiador (editor#28): narrows the Claude SDK's `settingSources` for
 * repositories of untrusted origin.
 *
 * Workspace Trust is the boundary for the agent: it only runs in trusted
 * folders. But a freshly cloned repository from a stranger is exactly the case
 * where "trusted enough to open" and "trusted enough to run its hooks" differ:
 * the SDK reads the repository's `.claude/settings.json`, whose `hooks` run
 * shell commands during the session. So a folder the user trusted for the
 * first time in this window starts its Claude session with the user's own
 * settings only, and a notification lists what the repository would run with
 * a one-click "Load Repository Settings".
 */
export const ICeliadorRepoSettingsTrustService = createDecorator<ICeliadorRepoSettingsTrustService>('celiadorRepoSettingsTrustService');

export interface ICeliadorRepoSettingsTrustService {
	readonly _serviceBrand: undefined;

	/** Whether any of `folders` (or a parent of one) was trusted for the first time in this window. */
	wasTrustedInThisWindow(folders: readonly URI[]): boolean;

	/**
	 * Tells the user that a session in one of `folders` started without the
	 * repository's own agent settings, listing the hook commands it skipped,
	 * when the repository has any. `load` switches the session back.
	 */
	notifyProjectSettingsSkipped(folders: readonly URI[], load: () => void): Promise<void>;
}

/** Files and folders whose presence means the SDK's `project`/`local` scopes would load something. */
const PROJECT_AGENT_SETTINGS = ['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];

/** The project-scope files the SDK reads hooks from (`settingSources: project, local`). */
const PROJECT_HOOK_FILES = [['.claude', 'settings.json'], ['.claude', 'settings.local.json']];

/** How many hook commands the notification names before summarizing the rest. */
const MAX_LISTED_COMMANDS = 3;

export class CeliadorRepoSettingsTrustService extends Disposable implements ICeliadorRepoSettingsTrustService {

	declare readonly _serviceBrand: undefined;

	/** Trusted URIs as of the last change seen; `undefined` until trust has initialized. */
	private _knownTrustedUris: readonly URI[] | undefined;
	private _workspaceTrusted = false;
	private readonly _newlyTrusted: URI[] = [];

	constructor(
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		void this._workspaceTrustManagementService.workspaceTrustInitialized.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this._knownTrustedUris = this._workspaceTrustManagementService.getTrustedUris();
			this._workspaceTrusted = this._workspaceTrustManagementService.isWorkspaceTrusted();
			this._register(this._workspaceTrustManagementService.onDidChangeTrustedFolders(() => this._onDidChangeTrustedFolders()));
			this._register(this._workspaceTrustManagementService.onDidChangeTrust(trusted => this._onDidChangeTrust(trusted)));
		});
	}

	private _onDidChangeTrustedFolders(): void {
		const current = this._workspaceTrustManagementService.getTrustedUris();
		const previous = this._knownTrustedUris ?? [];
		for (const uri of current) {
			if (!previous.some(known => this._uriIdentityService.extUri.isEqual(known, uri))) {
				this._newlyTrusted.push(uri);
			}
		}
		this._knownTrustedUris = current;
	}

	private _onDidChangeTrust(trusted: boolean): void {
		// An untrusted workspace that became trusted: its folders are newly trusted,
		// whether or not the grant also added them to the trusted-folder list.
		if (trusted && !this._workspaceTrusted) {
			this._newlyTrusted.push(...this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri));
		}
		this._workspaceTrusted = trusted;
	}

	wasTrustedInThisWindow(folders: readonly URI[]): boolean {
		return folders.some(folder => this._newlyTrusted.some(trusted => this._uriIdentityService.extUri.isEqualOrParent(folder, trusted)));
	}

	async notifyProjectSettingsSkipped(folders: readonly URI[], load: () => void): Promise<void> {
		try {
			for (const folder of folders) {
				if (!await this._hasProjectAgentSettings(folder)) {
					continue;
				}
				const commands = await this._readProjectHookCommands(folder);
				this._notificationService.prompt(Severity.Info, this._message(commands), [{
					label: localize('celiador.repoSettings.load', "Load Repository Settings"),
					run: load,
				}]);
				return;
			}
		} catch (error) {
			this._logService.warn('[Celiador] Could not describe the skipped repository agent settings', error);
		}
	}

	private _message(commands: readonly string[]): string {
		if (commands.length === 0) {
			return localize('celiador.repoSettings.skipped', "Claude started with your own settings only, because this folder was trusted for the first time. The repository's .claude settings, CLAUDE.md, agents and skills were not loaded.");
		}
		const listed = commands.slice(0, MAX_LISTED_COMMANDS).map(command => `"${command}"`).join(', ');
		return commands.length > MAX_LISTED_COMMANDS
			? localize('celiador.repoSettings.skippedCommandsMore', "Claude started with your own settings only, because this folder was trusted for the first time. The repository's .claude settings would run {0} and {1} more.", listed, commands.length - MAX_LISTED_COMMANDS)
			: localize('celiador.repoSettings.skippedCommands', "Claude started with your own settings only, because this folder was trusted for the first time. The repository's .claude settings would run {0}.", listed);
	}

	private async _hasProjectAgentSettings(folder: URI): Promise<boolean> {
		const found = await Promise.all(PROJECT_AGENT_SETTINGS.map(name => pathExists(joinPath(folder, name), this._fileService)));
		return found.some(Boolean);
	}

	private async _readProjectHookCommands(folder: URI): Promise<string[]> {
		const commands = new Set<string>();
		for (const segments of PROJECT_HOOK_FILES) {
			const uri = joinPath(folder, ...segments);
			const raw = await readJsonFile(uri, this._fileService);
			// The home directory only resolves `~` in a hook's cwd, which is not shown here.
			for (const group of parseHooksJson(uri, raw, folder, folder)) {
				for (const command of group.commands) {
					const text = command.command ?? command.osx ?? command.linux ?? command.windows;
					if (text) {
						commands.add(text);
					}
				}
			}
			for (const text of readSettingsHelperCommands(raw)) {
				commands.add(text);
			}
		}
		return [...commands];
	}
}

/** Claude settings keys, besides `hooks`, whose value is a shell command the CLI runs. */
const HELPER_COMMAND_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

function readSettingsHelperCommands(raw: unknown): string[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}
	const settings = raw as Record<string, unknown>;
	const commands = HELPER_COMMAND_KEYS.map(key => settings[key]);
	const statusLine = settings.statusLine;
	if (statusLine && typeof statusLine === 'object') {
		commands.push((statusLine as Record<string, unknown>).command);
	}
	return commands.filter((command): command is string => typeof command === 'string' && command.length > 0);
}

// Eager: it has to observe trust being granted before the first chat asks.
registerSingleton(ICeliadorRepoSettingsTrustService, CeliadorRepoSettingsTrustService, InstantiationType.Eager);
