/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Celiador: keep edits to files that change what the editor or the agent
// executes behind an explicit user approval, whatever the SDK permission mode.

import type { SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { isAbsolute, normalize, resolve } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { isAlwaysCheckedEditPath } from '../../../chat/common/chatSettings.js';
import { getClaudeToolPath, isClaudeFileEditTool } from './claudeToolDisplay.js';

/**
 * Prefix of the reason the SDK shows the model when the hook forces a prompt.
 * Exported so tests and the docs can refer to the one string.
 */
export const CLAUDE_PROTECTED_EDIT_REASON = 'This file can change what the editor or the agent executes, so it always needs your approval';

/**
 * SDK `PreToolUse` decision for file-edit tools that target an
 * always-checked path (`.vscode/*.json`, `.claude/settings*.json`, git
 * hooks, …; see `ALWAYS_CHECKED_EDIT_PATTERNS`).
 *
 * Why this exists in addition to the host's `SessionPermissionManager`: the
 * SDK only calls `canUseTool` for tools its own `permissionMode` does not
 * auto-approve. In `acceptEdits` (entered by approving an `ExitPlanMode`
 * plan) and `bypassPermissions` the SDK approves every file edit itself, so
 * the host's always-checked patterns are never consulted. A `PreToolUse`
 * hook runs before that auto-approval; answering `ask` routes the call to
 * `canUseTool` after all, where the host's rules then require the prompt.
 * Real workspace trust still gates the session itself; this is the
 * second line for a trusted-but-unreviewed repository.
 *
 * `cwd` is the SDK's reported working directory, used to absolutize a
 * relative path before matching. `..` segments are normalized so
 * `src/../.vscode/tasks.json` is seen as what it is. Matching is case-
 * insensitive on macOS and Windows (APFS and NTFS are), like the host.
 * Returns `undefined` for everything else, so the next hook decides.
 */
export function getClaudeProtectedEditDecision(toolName: string, input: unknown, cwd?: string): SyncHookJSONOutput | undefined {
	if (!isClaudeFileEditTool(toolName)) {
		return undefined;
	}
	const rawPath = getClaudeToolPath(toolName, input);
	if (!rawPath) {
		return undefined;
	}
	const absolute = isAbsolute(rawPath) ? rawPath : cwd ? resolve(cwd, rawPath) : rawPath;
	const normalized = normalize(absolute);
	if (!isAlwaysCheckedEditPath(normalized, !isLinux)) {
		return undefined;
	}
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'ask',
			permissionDecisionReason: `${CLAUDE_PROTECTED_EDIT_REASON}: ${normalized}`,
		},
	};
}
// --- End Celiador ---
