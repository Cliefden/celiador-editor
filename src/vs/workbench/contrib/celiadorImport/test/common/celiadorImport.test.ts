/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extensionIdsToImport, IMPORT_SOURCES, keybindingsToImport, settingsToImport, sourceExtensionsManifest, sourceUserDir } from '../../common/celiadorImport.js';

suite('celiadorImport', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const home = URI.file('/home/u');
	const cursor = IMPORT_SOURCES.find(s => s.id === 'cursor')!;

	test('finds each editor\'s user dir per OS and its extensions manifest', () => {
		assert.deepStrictEqual({
			mac: sourceUserDir(cursor, home, OperatingSystem.Macintosh).path,
			linux: sourceUserDir(cursor, home, OperatingSystem.Linux).path,
			windows: sourceUserDir(cursor, home, OperatingSystem.Windows).path,
			extensions: sourceExtensionsManifest(cursor, home).path,
		}, {
			mac: '/home/u/Library/Application Support/Cursor/User',
			linux: '/home/u/.config/Cursor/User',
			windows: '/home/u/AppData/Roaming/Cursor/User',
			extensions: '/home/u/.cursor/extensions/extensions.json',
		});
	});

	test('settings: Celiador values win, AI-layer and product keys are dropped', () => {
		const result = settingsToImport({
			'editor.fontSize': 15,
			'editor.tabSize': 2,
			'cursor.cpp.enablePartialAccepts': true,
			'github.copilot.enable': { '*': true },
			'telemetry.telemetryLevel': 'off',
			'workbench.colorTheme': 'Monokai',
		}, new Set(['editor.tabSize']));
		assert.deepStrictEqual(result, {
			toWrite: [['editor.fontSize', 15], ['workbench.colorTheme', 'Monokai']],
			dropped: ['cursor.cpp.enablePartialAccepts', 'github.copilot.enable', 'telemetry.telemetryLevel'],
		});
	});

	test('keybindings: duplicates, malformed rules and dropped commands are skipped', () => {
		const existing = [{ key: 'cmd+k', command: 'workbench.action.quickOpen' }];
		const result = keybindingsToImport([
			{ key: 'cmd+k', command: 'workbench.action.quickOpen' },
			{ key: 'cmd+j', command: 'editor.action.joinLines', when: 'editorTextFocus' },
			{ key: 'cmd+j', command: 'editor.action.joinLines', when: 'editorTextFocus' },
			{ key: 'cmd+l', command: 'cursor.chat.open' },
			{ key: 'tab', command: '-github.copilot.acceptSuggestion' },
			{ command: 'no.key' },
		], existing);
		assert.deepStrictEqual(result, [{ key: 'cmd+j', command: 'editor.action.joinLines', when: 'editorTextFocus' }]);
	});

	test('extensions: lower-cased, de-duplicated, installed ones skipped, AI and editor-specific ones blocked', () => {
		const result = extensionIdsToImport([
			{ identifier: { id: 'esbenp.prettier-vscode' } },
			{ identifier: { id: 'ESBenp.Prettier-VSCode' } },
			{ identifier: { id: 'dbaeumer.vscode-eslint' } },
			{ identifier: { id: 'GitHub.copilot' } },
			{ identifier: { id: 'anysphere.remote-ssh' } },
			{ identifier: { id: 'ms-vscode-remote.remote-ssh' } },
			{ identifier: {} },
			'garbage',
		], new Set(['dbaeumer.vscode-eslint']));
		assert.deepStrictEqual(result, {
			toInstall: ['esbenp.prettier-vscode'],
			blocked: ['github.copilot', 'anysphere.remote-ssh', 'ms-vscode-remote.remote-ssh'],
		});
	});

	test('extensions: a non-array manifest yields nothing', () => {
		assert.deepStrictEqual(extensionIdsToImport({ not: 'an array' }, new Set()), { toInstall: [], blocked: [] });
	});
});
// --- End Celiador ---
