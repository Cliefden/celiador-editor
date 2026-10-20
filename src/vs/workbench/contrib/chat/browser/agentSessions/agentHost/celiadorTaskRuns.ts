/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Celiador: which local agent sessions are agent-task runs. The editor control
// starts a task's run and records it here; the relay bridge reads it so the
// phone's view of that run is linked to its task and its file / git commands
// act on the run's own worktree instead of the window's checkout.

import { URI } from '../../../../../../base/common/uri.js';

/** One agent task running in this window, keyed by its session resource. */
export interface ICeliadorTaskRun {
	readonly taskId: string;
	readonly title: string;
	readonly branch: string;
	readonly issue?: { readonly number: number; readonly url: string };
	/** The window folder whose repository the run branched from. */
	readonly repoRoot: URI;
	/** The run's own worktree, once the host has created it. */
	worktree?: URI;
	/** Set once the run has been reported finished, so it is reported only once. */
	finished?: boolean;
}

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
// --- End Celiador ---
