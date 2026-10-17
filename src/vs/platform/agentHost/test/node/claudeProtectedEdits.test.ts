/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
import type { PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { join } from '../../../../base/common/path.js';
import { isLinux, isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_PROTECTED_EDIT_REASON, getClaudeProtectedEditDecision } from '../../node/claude/claudeProtectedEdits.js';

suite('claudeProtectedEdits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const cwd = isWindows ? 'C:\\work\\repo' : '/work/repo';

	function decision(toolName: string, input: unknown): 'ask' | undefined {
		const result = getClaudeProtectedEditDecision(toolName, input, cwd);
		if (result === undefined) {
			return undefined;
		}
		const output = result.hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
		assert.strictEqual(output?.hookEventName, 'PreToolUse');
		assert.ok(output?.permissionDecisionReason?.startsWith(CLAUDE_PROTECTED_EDIT_REASON));
		return output?.permissionDecision as 'ask' | undefined;
	}

	test('forces a prompt for every file-edit tool on an always-checked path, and only there', () => {
		const results = {
			writeTasks: decision('Write', { file_path: join(cwd, '.vscode', 'tasks.json') }),
			editSettings: decision('Edit', { file_path: join(cwd, '.vscode', 'settings.json') }),
			multiEditLaunch: decision('MultiEdit', { file_path: join(cwd, '.vscode', 'launch.json') }),
			notebookInClaude: decision('NotebookEdit', { notebook_path: join(cwd, '.claude', 'settings.local.json') }),
			claudeSettings: decision('Write', { file_path: join(cwd, '.claude', 'settings.json') }),
			gitHook: decision('Write', { file_path: join(cwd, '.git', 'hooks', 'pre-commit') }),
			huskyHook: decision('Write', { file_path: join(cwd, '.husky', 'pre-commit') }),
			ordinarySource: decision('Write', { file_path: join(cwd, 'src', 'app.ts') }),
			readOfSettings: decision('Read', { file_path: join(cwd, '.vscode', 'settings.json') }),
			bash: decision('Bash', { command: 'echo > .vscode/tasks.json' }),
			noPath: decision('Write', {}),
		};
		assert.deepStrictEqual(results, {
			writeTasks: 'ask',
			editSettings: 'ask',
			multiEditLaunch: 'ask',
			notebookInClaude: 'ask',
			claudeSettings: 'ask',
			gitHook: 'ask',
			huskyHook: 'ask',
			ordinarySource: undefined,
			readOfSettings: undefined,
			bash: undefined,
			noPath: undefined,
		});
	});

	test('normalizes dot-dot segments and resolves relative paths against the cwd', () => {
		const results = {
			dotDotIntoVscode: decision('Write', { file_path: join(cwd, 'src', '..', '.vscode', 'tasks.json') }),
			dotDotThroughFile: decision('Edit', { file_path: join(cwd, '.vscode', 'settings.json', '..', 'tasks.json') }),
			relative: decision('Write', { file_path: join('.claude', 'settings.json') }),
			relativeDotDot: decision('Write', { file_path: join('src', '..', '.git', 'hooks', 'post-checkout') }),
			dotDotOutAndBack: decision('Write', { file_path: join(cwd, '..', 'repo', 'src', 'app.ts') }),
		};
		assert.deepStrictEqual(results, {
			dotDotIntoVscode: 'ask',
			dotDotThroughFile: 'ask',
			relative: 'ask',
			relativeDotDot: 'ask',
			dotDotOutAndBack: undefined,
		});
	});

	if (!isLinux) {
		test('matches case-insensitively where the file system does', () => {
			const results = {
				upperVscode: decision('Write', { file_path: join(cwd, '.VSCODE', 'Tasks.JSON') }),
				upperClaude: decision('Edit', { file_path: join(cwd, '.Claude', 'SETTINGS.json') }),
				upperHooks: decision('Write', { file_path: join(cwd, '.GIT', 'HOOKS', 'pre-push') }),
			};
			assert.deepStrictEqual(results, { upperVscode: 'ask', upperClaude: 'ask', upperHooks: 'ask' });
		});
	}
});
// --- End Celiador ---
