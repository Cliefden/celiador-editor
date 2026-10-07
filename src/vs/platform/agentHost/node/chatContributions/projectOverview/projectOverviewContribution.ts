/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Celiador: grounds the Claude agent with a short project overview on the first turn of
// a chat (docs/CODEBASE_CONTEXT.md, option A), so it explores less before its first edit.

import * as fs from 'fs/promises';
import { join } from '../../../../../base/common/path.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../log/common/log.js';
import { AgentSession, CLAUDE_AGENT_PROVIDER_ID } from '../../../common/agent.js';
import { createChatMementoKey, type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IHydrationContext, type IOutgoingTurn, type ISendContribution } from '../../../common/agentHostChatContributionsService.js';
import type { Turn } from '../../../common/state/sessionState.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../agentHostStateManager.js';

const projectOverviewSentMemento = createChatMementoKey<boolean>('projectOverviewSent', () => false);

/** Entries listed from the project root before the listing is truncated. */
const MaxRootEntries = 60;
/** AGENTS.md is inlined up to this many characters. */
const MaxAgentsFileChars = 8000;
/** Root entries that are noise for orientation. */
const ignoredRootEntries = new Set(['.git', 'node_modules', '.DS_Store']);
/** Instruction files the Claude Agent SDK already loads on its own (`settingSources: project`). */
const claudeInstructionFiles = ['CLAUDE.md', '.claude/CLAUDE.md'];

/**
 * Adds the project's top-level layout, and its `AGENTS.md` when there is no
 * `CLAUDE.md` (the Claude SDK reads only the latter), to the first turn of each
 * Claude chat. Other providers read `AGENTS.md` natively and are left alone.
 */
export class ProjectOverviewContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'projectOverview';
	readonly order = 250;

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async onOutgoingTurn(turn: IOutgoingTurn): Promise<ISendContribution | undefined> {
		if (AgentSession.provider(turn.session) !== CLAUDE_AGENT_PROVIDER_ID) {
			return undefined;
		}
		const sent = this._context.memento(projectOverviewSentMemento, turn.chat);
		if (sent.get()) {
			return undefined;
		}
		sent.set(true, undefined);

		const workingDirectory = this._stateManager.getSessionState(turn.session)?.workingDirectories?.[0];
		if (!workingDirectory) {
			return undefined;
		}
		try {
			const overview = await this._buildOverview(URI.parse(workingDirectory));
			return overview ? { instructions: [overview] } : undefined;
		} catch (error) {
			this._logService.warn(`[projectOverview] Could not build the project overview for ${workingDirectory}`, error);
			return undefined;
		}
	}

	onHydrateTurns(context: IHydrationContext, turns: readonly Turn[]): readonly Turn[] {
		if (turns.length > 0) {
			this._context.memento(projectOverviewSentMemento, context.chat).set(true, undefined);
		}
		return turns;
	}

	private async _buildOverview(root: URI): Promise<string | undefined> {
		if (root.scheme !== 'file') {
			return undefined;
		}
		const rootPath = root.fsPath;
		const entries = (await fs.readdir(rootPath, { withFileTypes: true }))
			.filter(entry => !ignoredRootEntries.has(entry.name))
			.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
			.sort((a, b) => a.localeCompare(b));

		const hasClaudeInstructions = (await Promise.all(claudeInstructionFiles.map(p => isFile(join(rootPath, p))))).some(Boolean);
		const agentsFile = hasClaudeInstructions ? undefined : await readAgentsFile(join(rootPath, 'AGENTS.md'));

		const lines = [
			'<project_overview>',
			`The workspace root is ${rootPath}. Its top-level entries (directories end with "/"):`,
			...entries.slice(0, MaxRootEntries).map(entry => `- ${entry}`),
			...(entries.length > MaxRootEntries ? [`- … and ${entries.length - MaxRootEntries} more`] : []),
			'Use this to orient yourself before searching. To find where a named symbol is defined, prefer the workspace-symbol tool (if available) over a text search.',
		];
		if (agentsFile) {
			lines.push('', 'The project\'s AGENTS.md (its instructions for coding agents; follow them):', '<agents_md>', agentsFile, '</agents_md>');
		}
		lines.push('</project_overview>');
		return lines.join('\n');
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await fs.stat(path)).isFile();
	} catch {
		return false;
	}
}

async function readAgentsFile(path: string): Promise<string | undefined> {
	if (!await isFile(path)) {
		return undefined;
	}
	const handle = await fs.open(path, 'r');
	try {
		const buffer = Buffer.alloc(MaxAgentsFileChars * 4);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
		return text.length > MaxAgentsFileChars ? `${text.slice(0, MaxAgentsFileChars)}\n… (truncated)` : text;
	} finally {
		await handle.close();
	}
}
