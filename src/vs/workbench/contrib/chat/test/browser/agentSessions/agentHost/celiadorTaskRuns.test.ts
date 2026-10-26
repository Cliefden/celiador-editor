/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { celiadorPickedUpComment, ICeliadorTaskRun, parseCeliadorTaskRuns, serializeCeliadorTaskRuns } from '../../../../browser/agentSessions/agentHost/celiadorTaskRuns.js';

suite('CeliadorTaskRuns', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(taskId: string, startedAt: number, finished: boolean): ICeliadorTaskRun {
		return { taskId, title: `Task ${taskId}`, branch: `${taskId}-branch`, repoRoot: URI.file('/repo'), startedAt, finished, worktree: URI.file(`/wt/${taskId}`) };
	}

	test('round-trips run records and keeps every key of a run', () => {
		const a = run('a', 1, false);
		const raw = serializeCeliadorTaskRuns([['draft:/a', a], ['real:/a', a]]);
		const parsed = parseCeliadorTaskRuns(raw);
		assert.deepStrictEqual(parsed.map(([key, r]) => [key, r.taskId, r.worktree?.fsPath, r.finished]), [
			['draft:/a', 'a', URI.file('/wt/a').fsPath, false],
			['real:/a', 'a', URI.file('/wt/a').fsPath, false],
		]);
		assert.strictEqual(parsed[0][1], parsed[1][1]);
	});

	test('caps stored runs, dropping the oldest finished first', () => {
		const entries: Array<[string, ICeliadorTaskRun]> = [
			['s:/old', run('old', 1, true)],
			['s:/new', run('new', 3, true)],
			['s:/live', run('live', 0, false)],
		];
		const parsed = parseCeliadorTaskRuns(serializeCeliadorTaskRuns(entries, 2));
		assert.deepStrictEqual(parsed.map(([, r]) => r.taskId), ['live', 'new']);
	});

	test('ignores malformed storage', () => {
		assert.deepStrictEqual([parseCeliadorTaskRuns(undefined), parseCeliadorTaskRuns('{'), parseCeliadorTaskRuns('[{"taskId":1}]')], [[], [], []]);
	});

	test('picked-up comment wording', () => {
		assert.strictEqual(celiadorPickedUpComment({ machine: 'Stefan\'s MacBook Pro', branch: '49-cancel', baseBranch: 'main', taskId: 't1', openBaseUrl: 'https://celiador.ai/' }), [
			'**Picked up.** Running on Stefan\'s MacBook Pro in its own worktree, `49-cancel`.',
			'',
			'I\'ll open a pull request against `main` and link it here. Approvals and questions go to the Celiador queue.',
			'',
			'[Watch the run](https://celiador.ai/api/open/task/t1) · [Open the queue](https://celiador.ai/api/open/queue)',
		].join('\n'));
		assert.ok(celiadorPickedUpComment({ branch: 'b', taskId: 't', openBaseUrl: 'https://x' }).startsWith('**Picked up.** Running on a Mac in its own worktree'));
	});
});
