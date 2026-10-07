/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { AgentSignal } from '../../common/agent.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ClaudeExplorationTracker, IClaudeTurnExploration } from '../../node/claude/claudeExplorationTracker.js';

function toolStart(turnId: string, toolName: string): AgentSignal {
	return { kind: 'action', action: { type: ActionType.ChatToolCallStart, turnId, toolName } } as unknown as AgentSignal;
}

function turnComplete(turnId: string): AgentSignal {
	return { kind: 'action', action: { type: ActionType.ChatTurnComplete, turnId } } as unknown as AgentSignal;
}

suite('ClaudeExplorationTracker', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(signals: AgentSignal[]): (IClaudeTurnExploration | undefined)[] {
		const tracker = new ClaudeExplorationTracker();
		return signals.map(s => tracker.observe(s)).filter(Boolean);
	}

	test('counts searches and reads before the first edit, per turn', () => {
		assert.deepStrictEqual(run([
			toolStart('t1', 'Grep'),
			toolStart('t1', 'Glob'),
			toolStart('t1', 'Read'),
			toolStart('t1', 'workspaceSymbols'),
			toolStart('t1', 'Bash'),
			toolStart('t1', 'Edit'),
			toolStart('t1', 'Read'),
			turnComplete('t1'),
			toolStart('t2', 'Read'),
			toolStart('t2', 'mcp__client__usages'),
			turnComplete('t2'),
			turnComplete('t3'),
		]), [
			{ turnId: 't1', explorationBeforeFirstEdit: 4, searchesBeforeFirstEdit: 2, toolCalls: 7, edited: true },
			{ turnId: 't2', explorationBeforeFirstEdit: 2, searchesBeforeFirstEdit: 0, toolCalls: 2, edited: false },
		]);
	});
});
