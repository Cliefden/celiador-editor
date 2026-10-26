/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Celiador: which local agent sessions are agent-task runs. The editor control
// starts a task's run and records it here; the relay bridge reads it so the
// phone's view of that run is linked to its task and its file / git commands
// act on the run's own worktree instead of the window's checkout. Records are
// kept after a run finishes (follow-up turns, merge and the Agents view's diffs
// still target the worktree) and persisted per workspace by the editor control.

import { URI } from '../../../../../../base/common/uri.js';

/** One agent task running (or run) in this window, keyed by its session resource. */
export interface ICeliadorTaskRun {
	readonly taskId: string;
	readonly title: string;
	readonly branch: string;
	readonly issue?: { readonly number: number; readonly url: string };
	/** The window folder whose repository the run branched from. */
	readonly repoRoot: URI;
	/** When the run was started (epoch ms); orders records for the storage cap. */
	readonly startedAt: number;
	/** The run's own worktree, once the host has created it. */
	worktree?: URI;
	/** Set while the latest turn has been reported finished, so it is reported only once per turn. */
	finished?: boolean;
	/** The pull request the run opened, once it has one. */
	prUrl?: string;
}

/** The JSON shape a run record is stored as (URIs as strings). */
interface IStoredCeliadorTaskRun {
	readonly keys: string[];
	readonly taskId: string;
	readonly title: string;
	readonly branch: string;
	readonly issue?: { readonly number: number; readonly url: string };
	readonly repoRoot: string;
	readonly startedAt: number;
	readonly worktree?: string;
	readonly finished?: boolean;
	readonly prUrl?: string;
}

/** How many task runs a workspace remembers; the oldest finished ones go first. */
export const MAX_STORED_CELIADOR_TASK_RUNS = 50;

const runs = new Map<string, ICeliadorTaskRun>();

export function setCeliadorTaskRun(sessionResource: URI, run: ICeliadorTaskRun): void {
	runs.set(sessionResource.toString(), run);
}

export function getCeliadorTaskRun(sessionResource: URI | string): ICeliadorTaskRun | undefined {
	return runs.get(typeof sessionResource === 'string' ? sessionResource : sessionResource.toString());
}

export function deleteCeliadorTaskRun(sessionResource: URI | string): void {
	runs.delete(typeof sessionResource === 'string' ? sessionResource : sessionResource.toString());
}

export function celiadorTaskRunEntries(): IterableIterator<[string, ICeliadorTaskRun]> {
	return runs.entries();
}

/**
 * The run of task `taskId` and the session resources it is recorded under (a
 * run is recorded against the draft resource and, once opened, the real one).
 */
export function findCeliadorTaskRun(taskId: string): { run: ICeliadorTaskRun; keys: string[] } | undefined {
	let found: ICeliadorTaskRun | undefined;
	const keys: string[] = [];
	for (const [key, run] of runs) {
		if (run.taskId === taskId) {
			found = run;
			keys.push(key);
		}
	}
	return found ? { run: found, keys } : undefined;
}

/**
 * Serialize the given run records for workspace storage, capped at `max` runs:
 * unfinished runs are always kept, then the newest finished ones.
 */
export function serializeCeliadorTaskRuns(entries: Iterable<[string, ICeliadorTaskRun]>, max = MAX_STORED_CELIADOR_TASK_RUNS): string {
	const byRun = new Map<ICeliadorTaskRun, string[]>();
	for (const [key, run] of entries) {
		const keys = byRun.get(run) ?? [];
		keys.push(key);
		byRun.set(run, keys);
	}
	const ordered = [...byRun.entries()].sort(([a], [b]) => (a.finished === b.finished ? b.startedAt - a.startedAt : a.finished ? 1 : -1));
	const stored: IStoredCeliadorTaskRun[] = ordered.slice(0, max).map(([run, keys]) => ({
		keys,
		taskId: run.taskId,
		title: run.title,
		branch: run.branch,
		issue: run.issue,
		repoRoot: run.repoRoot.toString(),
		startedAt: run.startedAt,
		worktree: run.worktree?.toString(),
		finished: run.finished,
		prUrl: run.prUrl,
	}));
	return JSON.stringify(stored);
}

/** Parse what {@link serializeCeliadorTaskRuns} wrote; malformed records are skipped. */
export function parseCeliadorTaskRuns(raw: string | undefined): Array<[string, ICeliadorTaskRun]> {
	if (!raw) {
		return [];
	}
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(stored)) {
		return [];
	}
	const result: Array<[string, ICeliadorTaskRun]> = [];
	for (const item of stored as Partial<IStoredCeliadorTaskRun>[]) {
		if (!item || typeof item.taskId !== 'string' || typeof item.branch !== 'string' || typeof item.repoRoot !== 'string' || !Array.isArray(item.keys)) {
			continue;
		}
		const run: ICeliadorTaskRun = {
			taskId: item.taskId,
			title: typeof item.title === 'string' ? item.title : item.branch,
			branch: item.branch,
			issue: item.issue && typeof item.issue.number === 'number' && typeof item.issue.url === 'string' ? { number: item.issue.number, url: item.issue.url } : undefined,
			repoRoot: URI.parse(item.repoRoot),
			startedAt: typeof item.startedAt === 'number' ? item.startedAt : 0,
			worktree: typeof item.worktree === 'string' ? URI.parse(item.worktree) : undefined,
			finished: item.finished === true,
			prUrl: typeof item.prUrl === 'string' ? item.prUrl : undefined,
		};
		for (const key of item.keys) {
			if (typeof key === 'string') {
				result.push([key, run]);
			}
		}
	}
	return result;
}

/** The "picked up" comment the editor posts on a task's GitHub issue (agents UI contract §5). */
export function celiadorPickedUpComment(options: { readonly machine?: string; readonly branch: string; readonly baseBranch?: string; readonly taskId: string; readonly openBaseUrl: string }): string {
	const base = options.openBaseUrl.replace(/\/+$/, '');
	return [
		`**Picked up.** Running on ${options.machine?.trim() || 'a Mac'} in its own worktree, \`${options.branch}\`.`,
		'',
		`I'll open a pull request against \`${options.baseBranch?.trim() || 'main'}\` and link it here. Approvals and questions go to the Celiador queue.`,
		'',
		`[Watch the run](${base}/api/open/task/${encodeURIComponent(options.taskId)}) · [Open the queue](${base}/api/open/queue)`,
	].join('\n');
}
// --- End Celiador ---
