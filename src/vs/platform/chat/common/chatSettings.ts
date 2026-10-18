/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match as globMatch } from '../../../base/common/glob.js';

export const ChatAIDisabledSettingId = 'chat.disableAIFeatures';

/**
 * Configuration key gating the "Continue with Microsoft" sign-in choice. When `true`, every
 * sign-in dialog offers it, and choosing it exchanges a Microsoft Entra sign-in for a GitHub
 * token that is published as a process-lifetime GitHub authentication session. Off by default
 * while the flow is dogfooded.
 */
export const ChatMicrosoftAuthenticationEnabledSettingId = 'chat.microsoftAuthentication.enabled';

export const ChatEditAutoApproveSettingId = 'chat.tools.edits.autoApprove';

export type ChatEditAutoApprovePatterns = Readonly<Record<string, boolean>>;

export const enum ChatExternalSessionsMode {
	Recent = 'recent',
	None = 'none',
	Last24Hours = 'last24Hours',
	Last7Days = 'last7Days',
	Last30Days = 'last30Days',
}

/** Edit paths whose executable side effects require confirmation regardless of user configuration. */
export const ALWAYS_CHECKED_EDIT_PATTERNS: ChatEditAutoApprovePatterns = {
	'**/.mcp.json': false,
	'**/.npmrc': false,
	'**/.vscode/*.json': false,
	'**/.github/agents/**': false,
	'**/.github/hooks/**': false,
	'**/.claude/agents/**': false,
	'**/.claude/settings.json': false,
	'**/.claude/settings.local.json': false,
	'**/.codex/agents/**': false,
	'**/.codex/config.toml': false,
	'**/.codex/hooks.json': false,
	// --- Start Celiador ---
	// Git hooks run on the next commit/checkout/push; upstream only lists
	// `.git/**` in the user-overridable defaults. Husky keeps its hooks outside
	// `.git`, so it needs its own entry.
	'**/.git/hooks/**': false,
	'**/.husky/**': false,
	// `.git/config` can point hooks anywhere (`core.hooksPath`) or run a command
	// on every status (`core.fsmonitor`), so guarding `.git/hooks` alone is not
	// enough. A `.code-workspace` file carries settings and tasks exactly like
	// `.vscode/*.json` does.
	'**/.git/config': false,
	'**/*.code-workspace': false,
	// --- End Celiador ---
};

// --- Start Celiador ---
/**
 * Whether `fsPath` matches one of the {@link ALWAYS_CHECKED_EDIT_PATTERNS}.
 * Shared by the agent host's write auto-approval and the Claude SDK
 * `PreToolUse` hook, so both layers protect exactly the same files. The caller
 * normalizes the path (`..`, separators) first; `ignoreCase` should follow the
 * file system (macOS and Windows are case-insensitive).
 */
export function isAlwaysCheckedEditPath(fsPath: string, ignoreCase: boolean): boolean {
	for (const [pattern, approved] of Object.entries(ALWAYS_CHECKED_EDIT_PATTERNS)) {
		if (approved === false && globMatch(pattern, fsPath, { ignoreCase })) {
			return true;
		}
	}
	return false;
}
// --- End Celiador ---

export const DEFAULT_EDIT_AUTO_APPROVE_PATTERNS: ChatEditAutoApprovePatterns = {
	'**/*': true,
	'**/.git/**': false,
	'**/{package.json,server.xml,build.rs,web.config,.gitattributes,.env,Cargo.toml}': false,
	'**/{.npmrc,.yarnrc,.yarnrc.yml,.pnpmfile.js,.pnpmfile.cjs,.pnpmfile.mjs,pnpm-workspace.yaml}': false,
	'**/*.{code-workspace,csproj,fsproj,vbproj,vcxproj,proj,targets,props,gradle,gradle.kts}': false,
	'**/gradle.properties': false,
	'**/ruby_lsp/*/addon': false,
	'**/*.lock': false,
	'**/*-lock.{yaml,json}': false,
	...ALWAYS_CHECKED_EDIT_PATTERNS,
};

export function mergeChatEditAutoApprovePatterns(value: unknown): ChatEditAutoApprovePatterns {
	const patterns: Record<string, boolean> = { ...DEFAULT_EDIT_AUTO_APPROVE_PATTERNS };
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return patterns;
	}
	for (const [pattern, isApproved] of Object.entries(value)) {
		// Re-inserting moves an overridden default to the end so the configured
		// order keeps deciding which pattern matches last.
		delete patterns[pattern];
		patterns[pattern] = isApproved === true;
	}
	return patterns;
}
