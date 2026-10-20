/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getWorktreeName, isPlausibleBranchName } from '../../node/shared/worktreeIsolation.js';

suite('Celiador worktree branch name', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts agent-task branch names and refuses what git would reject or misread', () => {
		const names = ['52-relay-backoff', 'celiador-a1b2c3-tidy-the-readme', 'feature/x.y', '..', 'a..b', 'a//b', 'ends/', 'ends.', 'x.lock', '-leading', 'has space', 'at@{1}', ''];
		assert.deepStrictEqual(Object.fromEntries(names.map(n => [n, isPlausibleBranchName(n)])), {
			'52-relay-backoff': true,
			'celiador-a1b2c3-tidy-the-readme': true,
			'feature/x.y': true,
			'..': false,
			'a..b': false,
			'a//b': false,
			'ends/': false,
			'ends.': false,
			'x.lock': false,
			'-leading': false,
			'has space': false,
			'at@{1}': false,
			'': false,
		});
	});

	test('an exact task branch keeps its name as the worktree folder', () => {
		assert.strictEqual(getWorktreeName('52-relay-backoff'), '52-relay-backoff');
	});
});
// --- End Celiador ---
