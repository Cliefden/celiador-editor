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

	test('guards git config and workspace files, which carry hooks and settings too', () => {
		const results = {
			gitConfig: decision('Edit', { file_path: join(cwd, '.git', 'config') }),
			workspaceFile: decision('Write', { file_path: join(cwd, 'celiador.code-workspace') }),
			gitIndex: decision('Write', { file_path: join(cwd, '.git', 'index') }),
		};
		assert.deepStrictEqual(results, { gitConfig: 'ask', workspaceFile: 'ask', gitIndex: undefined });
	});

	suite('symlinks', () => {
		// A repo can ship `build -> .vscode` and `cfg -> <outside>/.claude`; the
		// target files need not exist yet (the agent is about to create them).
		const existing = new Set([cwd, join(cwd, 'src'), join(cwd, '.vscode')]);
		const links = new Map([
			[join(cwd, 'build'), join(cwd, '.vscode')],
			[join(cwd, 'cfg'), isWindows ? 'C:\\elsewhere\\.claude' : '/elsewhere/.claude'],
		]);
		const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		const fakeRealpath = (fsPath: string): string => {
			const linked = links.get(fsPath);
			if (linked) {
				return linked;
			}
			if (existing.has(fsPath)) {
				return fsPath;
			}
			throw enoent();
		};

		function linkedDecision(toolName: string, input: unknown): 'ask' | undefined {
			const result = getClaudeProtectedEditDecision(toolName, input, cwd, fakeRealpath);
			const output = result?.hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
			return output?.permissionDecision as 'ask' | undefined;
		}

		test('sees through a symlinked directory, even for a file that does not exist yet', () => {
			const results = {
				viaLinkIntoVscode: linkedDecision('Write', { file_path: join(cwd, 'build', 'tasks.json') }),
				viaLinkOutsideRepo: linkedDecision('Write', { file_path: join('cfg', 'settings.json') }),
				viaLinkOrdinaryFile: linkedDecision('Write', { file_path: join(cwd, 'build', 'notes.txt') }),
				plainSource: linkedDecision('Write', { file_path: join(cwd, 'src', 'app.ts') }),
			};
			assert.deepStrictEqual(results, {
				viaLinkIntoVscode: 'ask',
				viaLinkOutsideRepo: 'ask',
				viaLinkOrdinaryFile: undefined,
				plainSource: undefined,
			});
		});

		test('still prompts for the literal path when nothing on the way resolves', () => {
			const broken = (): string => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
			const result = getClaudeProtectedEditDecision('Write', { file_path: join(cwd, '.vscode', 'tasks.json') }, cwd, broken);
			const output = result?.hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
			assert.strictEqual(output?.permissionDecision, 'ask');
		});
	});
});
// --- End Celiador ---
