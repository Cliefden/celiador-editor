/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { summarizeRelayToolInput } from '../../../../browser/agentSessions/agentHost/celiadorRelayClient.js';

suite('CeliadorRelayToolInput', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes only a path, command or pattern', () => {
		const long = 'x'.repeat(300);
		assert.deepStrictEqual([
			summarizeRelayToolInput('Read', JSON.stringify({ file_path: '/wt/app/SessionView.swift', limit: 20 }), '/wt'),
			summarizeRelayToolInput('Write', JSON.stringify({ file_path: '/elsewhere/a.ts', content: 'secret' }), '/wt'),
			summarizeRelayToolInput('Bash', JSON.stringify({ command: 'npm test -- relay', description: 'run' }), '/wt'),
			summarizeRelayToolInput('Grep', JSON.stringify({ pattern: 'TODO', path: '/wt/src' }), '/wt'),
			summarizeRelayToolInput('Bash', JSON.stringify({ command: long }), '/wt').command?.length,
			summarizeRelayToolInput('Edit', 'not json', '/wt'),
			summarizeRelayToolInput('WebFetch', JSON.stringify({ url: 'https://x', prompt: 'p' }), '/wt'),
			// The Claude host's own shapes for shell / search tools: the bare string.
			summarizeRelayToolInput('Bash', 'git add greet.js README.md', '/wt'),
			summarizeRelayToolInput('Glob', '**/*.ts', '/wt'),
		], [
			{ path: 'app/SessionView.swift' },
			{ path: '/elsewhere/a.ts' },
			{ command: 'npm test -- relay' },
			{ pattern: 'TODO' },
			200,
			{},
			{},
			{ command: 'git add greet.js README.md' },
			{ pattern: '**/*.ts' },
		]);
	});
});
