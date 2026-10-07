/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Celiador: measures how much the agent explores before its first edit in a turn. This is
// the signal that decides whether semantic search is worth building (docs/CODEBASE_CONTEXT.md).

import { ActionType } from '../../common/state/sessionActions.js';
import type { AgentSignal } from '../../common/agent.js';
import { getClaudeToolKind, isClaudeFileEditTool } from './claudeToolDisplay.js';

/**
 * Client (workbench) tools that count as exploration. The stream mapper strips the
 * `mcp__client__` prefix, so they normally arrive bare; the prefixed form is matched too.
 */
const clientExplorationTools = ['workspaceSymbols', 'usages'];

/** Per-turn exploration counts, reported when the turn completes. */
export interface IClaudeTurnExploration {
	readonly turnId: string;
	/** Search/read calls before the first file edit (all of them when the turn made no edit). */
	readonly explorationBeforeFirstEdit: number;
	/** Of those, text/file-name searches (`Grep`, `Glob`). */
	readonly searchesBeforeFirstEdit: number;
	readonly toolCalls: number;
	readonly edited: boolean;
}

interface ITurnCounts {
	exploration: number;
	searches: number;
	toolCalls: number;
	edited: boolean;
}

function isExplorationTool(toolName: string): boolean {
	const kind = getClaudeToolKind(toolName);
	if (kind === 'read' || kind === 'search' || toolName === 'LS') {
		return true;
	}
	return clientExplorationTools.some(name => toolName === name || toolName === `mcp__client__${name}`);
}

/** Observes a session's agent signals and summarizes exploration per completed turn. */
export class ClaudeExplorationTracker {

	private readonly _turns = new Map<string, ITurnCounts>();

	/** Returns the turn's summary when `signal` completes a turn that made tool calls. */
	observe(signal: AgentSignal): IClaudeTurnExploration | undefined {
		if (signal.kind !== 'action') {
			return undefined;
		}
		const action = signal.action;
		if (action.type === ActionType.ChatToolCallStart) {
			let counts = this._turns.get(action.turnId);
			if (!counts) {
				counts = { exploration: 0, searches: 0, toolCalls: 0, edited: false };
				this._turns.set(action.turnId, counts);
			}
			counts.toolCalls++;
			if (isClaudeFileEditTool(action.toolName)) {
				counts.edited = true;
			} else if (!counts.edited && isExplorationTool(action.toolName)) {
				counts.exploration++;
				if (getClaudeToolKind(action.toolName) === 'search') {
					counts.searches++;
				}
			}
			return undefined;
		}
		if (action.type === ActionType.ChatTurnComplete) {
			const counts = this._turns.get(action.turnId);
			this._turns.delete(action.turnId);
			if (!counts) {
				return undefined;
			}
			return {
				turnId: action.turnId,
				explorationBeforeFirstEdit: counts.exploration,
				searchesBeforeFirstEdit: counts.searches,
				toolCalls: counts.toolCalls,
				edited: counts.edited,
			};
		}
		return undefined;
	}
}
