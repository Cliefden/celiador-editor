/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IAgentHostChatContributionContext, IOutgoingTurn } from '../../common/agentHostChatContributionsService.js';
import type { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { ProjectOverviewContribution } from '../../node/chatContributions/projectOverview/projectOverviewContribution.js';

suite('ProjectOverviewContribution', () => {

	const disposables = new DisposableStore();
	let rootPath: string;
	let root: URI;

	/** A context whose mementos are plain in-memory values. */
	function createContext(): IAgentHostChatContributionContext {
		const values = new Map<string, unknown>();
		return {
			memento: (key: { debugName: string; create: () => unknown }, chat: string) => ({
				get: () => values.has(`${key.debugName}:${chat}`) ? values.get(`${key.debugName}:${chat}`) : key.create(),
				set: (value: unknown) => values.set(`${key.debugName}:${chat}`, value),
			}),
		} as unknown as IAgentHostChatContributionContext;
	}

	function createContribution(): ProjectOverviewContribution {
		const stateManager = { getSessionState: () => ({ workingDirectories: [root.toString()] }) } as unknown as AgentHostStateManager;
		return disposables.add(new ProjectOverviewContribution(createContext(), stateManager, new NullLogService()));
	}

	function turn(session: string, chat = 'agent-host-chat://one'): IOutgoingTurn {
		return { session, chat, turnId: 't1', message: { text: 'hi' } } as unknown as IOutgoingTurn;
	}

	async function write(path: string, content = ''): Promise<void> {
		await fs.mkdir(dirname(join(rootPath, path)), { recursive: true });
		await fs.writeFile(join(rootPath, path), content);
	}

	setup(async () => {
		rootPath = getRandomTestPath(tmpdir(), 'vsctests', 'projectOverview');
		root = URI.file(rootPath);
		await write('package.json', '{}');
		await write('src/index.ts');
		await fs.mkdir(join(rootPath, 'node_modules'));
	});

	teardown(async () => {
		disposables.clear();
		await fs.rm(rootPath, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the root layout and AGENTS.md to the first Claude turn only', async () => {
		await write('AGENTS.md', 'Run `npm test` before committing.');
		const contribution = createContribution();

		const first = await contribution.onOutgoingTurn(turn('claude:/s1'));
		const second = await contribution.onOutgoingTurn(turn('claude:/s1'));

		assert.deepStrictEqual({ first: first?.instructions?.[0].split('\n'), second }, {
			first: [
				'<project_overview>',
				`The workspace root is ${root.fsPath}. Its top-level entries (directories end with "/"):`,
				'- AGENTS.md',
				'- package.json',
				'- src/',
				'Use this to orient yourself before searching.',
				'',
				'The project\'s AGENTS.md (its instructions for coding agents; follow them):',
				'<agents_md>',
				'Run `npm test` before committing.',
				'</agents_md>',
				'</project_overview>',
			],
			second: undefined,
		});
	});

	test('skips AGENTS.md when CLAUDE.md exists, and ignores non-Claude sessions', async () => {
		await write('AGENTS.md', 'agents');
		await write('CLAUDE.md', 'claude');
		const contribution = createContribution();

		const copilot = await contribution.onOutgoingTurn(turn('copilotcli:/s1'));
		const claude = await contribution.onOutgoingTurn(turn('claude:/s2', 'agent-host-chat://two'));

		assert.deepStrictEqual({ copilot, mentionsAgentsFile: claude?.instructions?.[0].includes('<agents_md>') }, {
			copilot: undefined,
			mentionsAgentsFile: false,
		});
	});
});
