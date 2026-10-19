/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Celiador: pure logic behind "Import Settings from Another Editor" — where the
// other VS Code-family editors keep their user data, and what of it carries over.
// No services here, so every rule is unit-testable.

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { OperatingSystem } from '../../../../base/common/platform.js';

/** A VS Code-family editor whose user data Celiador can import. */
export interface IImportSource {
	readonly id: string;
	/** Shown in the picker. */
	readonly label: string;
	/** `<appData>/<folder>/User` holds settings.json, keybindings.json, snippets/. */
	readonly appDataFolder: string;
	/** `~/<folder>/extensions/extensions.json` lists the installed extensions. */
	readonly extensionsFolder: string;
}

export const IMPORT_SOURCES: readonly IImportSource[] = [
	{ id: 'cursor', label: 'Cursor', appDataFolder: 'Cursor', extensionsFolder: '.cursor' },
	{ id: 'vscode', label: 'Visual Studio Code', appDataFolder: 'Code', extensionsFolder: '.vscode' },
	{ id: 'vscode-insiders', label: 'Visual Studio Code - Insiders', appDataFolder: 'Code - Insiders', extensionsFolder: '.vscode-insiders' },
	{ id: 'vscodium', label: 'VSCodium', appDataFolder: 'VSCodium', extensionsFolder: '.vscode-oss' },
];

/** The per-user application-data root on each OS (where `<App>/User` lives). */
export function appDataRoot(userHome: URI, os: OperatingSystem): URI {
	switch (os) {
		case OperatingSystem.Macintosh: return joinPath(userHome, 'Library', 'Application Support');
		case OperatingSystem.Windows: return joinPath(userHome, 'AppData', 'Roaming');
		default: return joinPath(userHome, '.config');
	}
}

export function sourceUserDir(source: IImportSource, userHome: URI, os: OperatingSystem): URI {
	return joinPath(appDataRoot(userHome, os), source.appDataFolder, 'User');
}

export function sourceExtensionsManifest(source: IImportSource, userHome: URI): URI {
	return joinPath(userHome, source.extensionsFolder, 'extensions', 'extensions.json');
}

/**
 * Setting keys that must not come across: the other editor's own product
 * settings and the AI layers Celiador replaces. Prefix match on the dotted key.
 */
const DROPPED_SETTING_PREFIXES = ['cursor.', 'cursorai.', 'github.copilot', 'chat.', 'update.', 'telemetry.', 'workbench.experimental.'];

/** Extensions that duplicate or conflict with Celiador's built-in AI layer, or only work in the source editor. */
const BLOCKED_EXTENSION_PREFIXES = ['github.copilot', 'anysphere.', 'cursor.', 'ms-vscode-remote.', 'ms-vscode.remote-'];

export function isImportableSetting(key: string): boolean {
	const lower = key.toLowerCase();
	return !DROPPED_SETTING_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export function isImportableExtension(id: string): boolean {
	const lower = id.toLowerCase();
	return !BLOCKED_EXTENSION_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * The settings to write: every importable key of `source` that Celiador's user
 * settings do not already set — an existing Celiador value always wins.
 */
export function settingsToImport(source: Record<string, unknown>, existingUserKeys: ReadonlySet<string>): { readonly toWrite: [string, unknown][]; readonly dropped: string[] } {
	const toWrite: [string, unknown][] = [];
	const dropped: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (!isImportableSetting(key)) {
			dropped.push(key);
		} else if (!existingUserKeys.has(key)) {
			toWrite.push([key, value]);
		}
	}
	return { toWrite, dropped };
}

/** One keybindings.json rule, as far as identity is concerned. */
export interface IKeybindingRule {
	readonly key?: unknown;
	readonly command?: unknown;
	readonly when?: unknown;
}

function ruleIdentity(rule: IKeybindingRule): string {
	return JSON.stringify([rule.key, rule.command, rule.when ?? null]);
}

/** Source rules not already present (same key, command and when) and not bound to a dropped command. */
export function keybindingsToImport(source: readonly IKeybindingRule[], existing: readonly IKeybindingRule[]): IKeybindingRule[] {
	const seen = new Set(existing.map(ruleIdentity));
	const result: IKeybindingRule[] = [];
	for (const rule of source) {
		if (!rule || typeof rule.key !== 'string' || typeof rule.command !== 'string') {
			continue;
		}
		const command = rule.command.replace(/^-/, '');
		if (!isImportableSetting(command)) {
			continue; // e.g. cursor.*, github.copilot.* commands
		}
		const identity = ruleIdentity(rule);
		if (!seen.has(identity)) {
			seen.add(identity);
			result.push(rule);
		}
	}
	return result;
}

/** Extension ids from a VS Code-format extensions.json (`[{ identifier: { id } }]`), de-duplicated, importable only. */
export function extensionIdsToImport(manifest: unknown, installedIds: ReadonlySet<string>): { readonly toInstall: string[]; readonly blocked: string[] } {
	const toInstall: string[] = [];
	const blocked: string[] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(manifest) ? manifest : []) {
		const id = (entry as { identifier?: { id?: unknown } })?.identifier?.id;
		if (typeof id !== 'string' || !id.includes('.')) {
			continue;
		}
		const lower = id.toLowerCase();
		if (seen.has(lower)) {
			continue;
		}
		seen.add(lower);
		if (!isImportableExtension(lower)) {
			blocked.push(lower);
		} else if (!installedIds.has(lower)) {
			toInstall.push(lower);
		}
	}
	return { toInstall, blocked };
}
// --- End Celiador ---
