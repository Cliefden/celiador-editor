/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../../../base/common/async.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';

/**
 * Celiador: heartbeat the repos currently open in this editor to the daemon, so the
 * companion phone can offer a "from your editor" repo picker (feeding its cloud run)
 * instead of making you type a clone URL on a phone keyboard.
 *
 * Best-effort and privacy-light: it publishes only the folder name + a normalised
 * https remote URL (+ branch), never the local path. Nothing is sent while signed
 * out, and the daemon ages entries out via TTL so closing the editor clears them.
 */
export class CeliadorWorkspacePresence extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.celiadorWorkspacePresence';

	/** Must match the auth provider id registered by the celiador-ai extension. */
	private static readonly AUTH_PROVIDER_ID = 'celiador';
	private static readonly FALLBACK_DAEMON_URL = 'https://celiador.ai';
	/** Re-publish every 30s; the daemon's TTL is ~3× this, so a blip doesn't drop us. */
	private static readonly HEARTBEAT_MS = 30_000;

	/** Identifies this editor instance so its set replaces (not appends) on the daemon. */
	private readonly _clientId = generateUuid();

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => void this._publish(), CeliadorWorkspacePresence.HEARTBEAT_MS);
		this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => void this._publish()));
		void this._publish();
	}

	private _daemonUrl(): string {
		return (this._productService.celiadorDaemonUrl ?? CeliadorWorkspacePresence.FALLBACK_DAEMON_URL).replace(/\/+$/, '');
	}

	private async _token(): Promise<string | undefined> {
		try {
			const sessions = await this._authenticationService.getSessions(CeliadorWorkspacePresence.AUTH_PROVIDER_ID, []);
			return sessions[0]?.accessToken;
		} catch {
			return undefined;
		}
	}

	private async _publish(): Promise<void> {
		const token = await this._token();
		if (!token) {
			return; // signed out → nothing to publish (daemon TTL clears any stale set)
		}
		const repos = await findOpenRepos(this._workspaceService, this._fileService);
		const workspaces = repos.map(({ name, remoteUrl, branch }) => ({ name, remoteUrl, branch }));
		try {
			// Heartbeat even when empty so the daemon ages out folders that were closed.
			await fetch(`${this._daemonUrl()}/api/presence/workspaces`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ clientId: this._clientId, workspaces }),
			});
		} catch (e) {
			this._logService.trace(`[celiador-presence] publish failed: ${e}`);
		}
	}
}

/** A git checkout reachable from the window's folders, with an https origin. */
export interface ICeliadorOpenRepo {
	readonly name: string;
	readonly remoteUrl: string;
	readonly branch?: string;
	readonly folder: URI;
	/** Found inside a workspace folder rather than being one. */
	readonly nested: boolean;
}

/** The daemon rejects a presence heartbeat with more entries than this. */
const MAX_REPOS = 50;
/** Subfolders never worth looking into for a nested checkout. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'vendor', 'Pods']);

/**
 * The checkouts reachable from the window's folders: each folder that is itself
 * a checkout, and otherwise the checkouts directly inside it, so a window on a
 * folder of repos offers every repo in it rather than none. Worktrees (whose
 * `.git` is a file) count too.
 */
export async function findOpenRepos(workspaceService: IWorkspaceContextService, fileService: IFileService): Promise<ICeliadorOpenRepo[]> {
	const repos: ICeliadorOpenRepo[] = [];
	const seen = new Set<string>();
	const add = async (name: string, folder: URI, nested: boolean): Promise<boolean> => {
		const info = await gitInfo(fileService, folder);
		if (info && !seen.has(folder.toString())) {
			seen.add(folder.toString());
			repos.push({ name, remoteUrl: info.remoteUrl, branch: info.branch, folder, nested });
		}
		return !!info;
	};
	for (const folder of workspaceService.getWorkspace().folders) {
		if (await add(folder.name, folder.uri, false) || await fileService.exists(joinPath(folder.uri, '.git'))) {
			continue;
		}
		let children;
		try {
			children = (await fileService.resolve(folder.uri)).children ?? [];
		} catch {
			continue;
		}
		for (const child of children) {
			if (child.isDirectory && !child.name.startsWith('.') && !SKIP_DIRS.has(child.name)) {
				await add(child.name, child.resource, true);
			}
		}
	}
	return repos.slice(0, MAX_REPOS);
}

/**
 * The git directory of the checkout at `root` and the directory holding its
 * config: both `.git` for a normal checkout; for a worktree (`.git` is a file
 * `gitdir: …/.git/worktrees/<name>`) the worktree's gitdir and the main repo's
 * `.git` (via `commondir`).
 */
async function gitDirs(fileService: IFileService, root: URI): Promise<{ gitDir: URI; commonDir: URI } | undefined> {
	const dotGit = joinPath(root, '.git');
	let stat;
	try {
		stat = await fileService.stat(dotGit);
	} catch {
		return undefined;
	}
	if (stat.isDirectory) {
		return { gitDir: dotGit, commonDir: dotGit };
	}
	const gitdir = /^gitdir:\s*(.+)$/m.exec((await fileService.readFile(dotGit)).value.toString())?.[1]?.trim();
	if (!gitdir) {
		return undefined;
	}
	const gitDir = /^(\/|[a-zA-Z]:[\\/])/.test(gitdir) ? URI.file(gitdir) : joinPath(root, gitdir);
	try {
		const common = (await fileService.readFile(joinPath(gitDir, 'commondir'))).value.toString().trim();
		return { gitDir, commonDir: /^(\/|[a-zA-Z]:[\\/])/.test(common) ? URI.file(common) : joinPath(gitDir, common) };
	} catch {
		return { gitDir, commonDir: gitDir }; // not a worktree gitdir (e.g. a submodule)
	}
}

/** A checkout's origin remote (normalised to https) and current branch, if any. */
async function gitInfo(fileService: IFileService, root: URI): Promise<{ remoteUrl: string; branch?: string } | undefined> {
	try {
		const dirs = await gitDirs(fileService, root);
		if (!dirs) {
			return undefined;
		}
		const config = (await fileService.readFile(joinPath(dirs.commonDir, 'config'))).value.toString();
		const remote = parseRemoteUrl(config);
		if (!remote) {
			return undefined;
		}
		const remoteUrl = normalizeToHttps(remote);
		if (!remoteUrl) {
			return undefined; // only https clone URLs are usable by the cloud run
		}
		let branch: string | undefined;
		try {
			const head = (await fileService.readFile(joinPath(dirs.gitDir, 'HEAD'))).value.toString().trim();
			branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
		} catch {
			/* detached HEAD or unreadable — branch stays undefined */
		}
		return { remoteUrl, branch };
	} catch {
		return undefined;
	}
}

/** Pick the origin remote url from a git config (else the first remote). */
export function parseRemoteUrl(config: string): string | undefined {
	const remotes = new Map<string, string>();
	let current: string | undefined;
	for (const line of config.split(/\r?\n/)) {
		const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
		if (section) {
			current = section[1];
			continue;
		}
		if (/^\s*\[/.test(line)) {
			current = undefined;
			continue;
		}
		if (current) {
			const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
			if (url && !remotes.has(current)) {
				remotes.set(current, url[1]);
			}
		}
	}
	return remotes.get('origin') ?? [...remotes.values()][0];
}

/** Normalise a git remote (scp/ssh/git/https) to a credential-free https URL, or undefined. */
export function normalizeToHttps(url: string): string | undefined {
	if (/^https:\/\//i.test(url)) {
		return url.replace(/^(https:\/\/)[^@/]+@/i, '$1'); // strip any embedded creds
	}
	let m = /^[^@]+@([^:]+):(.+)$/.exec(url); // git@host:owner/repo.git
	if (m) {
		return `https://${m[1]}/${m[2]}`;
	}
	m = /^ssh:\/\/[^@/]+@([^/]+)\/(.+)$/.exec(url); // ssh://git@host/owner/repo.git
	if (m) {
		return `https://${m[1]}/${m[2]}`;
	}
	m = /^git:\/\/([^/]+)\/(.+)$/.exec(url); // git://host/owner/repo.git
	if (m) {
		return `https://${m[1]}/${m[2]}`;
	}
	return undefined; // http:// (insecure) or unrecognised → skip
}
