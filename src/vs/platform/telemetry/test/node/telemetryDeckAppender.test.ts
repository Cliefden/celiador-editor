/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { allowedPayloadKeys, buildTelemetryDeckSignal, hashClientUser, ITelemetryDeckSignalContext } from '../../node/telemetryDeckAppender.js';

suite('TelemetryDeckAppender', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const context: ITelemetryDeckSignalContext = {
		appId: 'app-1',
		clientUser: 'hashed-user',
		sessionId: 'session-1',
		appVersion: '1.138.0',
		commit: '0123456789abcdef',
		isTestMode: false,
		receivedAt: '2026-10-18T10:00:00.000Z',
	};

	test('allowlist: own events, a few core events, nothing else', () => {
		assert.deepStrictEqual(
			[allowedPayloadKeys('celiador/phoneCommand'), allowedPayloadKeys('UnhandledError'), allowedPayloadKeys('editorOpened'), allowedPayloadKeys('workbenchActionExecuted')],
			['all', ['uncaught_error_name', 'count'], undefined, undefined]
		);
	});

	test('client user is a stable salted hash, never the machine id', () => {
		const a = hashClientUser('machine-1', 'salt');
		assert.deepStrictEqual(
			[a.length, a === hashClientUser('machine-1', 'salt'), a === hashClientUser('machine-1', 'other'), a.includes('machine')],
			[64, true, false, false]
		);
	});

	test('own event: forwards its keys, maps device common properties, drops the rest', () => {
		const signal = buildTelemetryDeckSignal('celiador/phoneCommand', {
			command: 'git.pr',
			count: 2,
			nested: { not: 'forwarded' },
			'common.platform': 'Mac',
			'common.platformVersion': '26.1',
			'common.nodeArch': 'arm64',
			'common.machineId': 'machine-1',
			'common.sqmId': 'sqm',
			sessionID: 'vscode-session',
		}, context);
		assert.deepStrictEqual(signal, {
			clientUser: 'hashed-user',
			sessionID: 'vscode-session',
			appID: 'app-1',
			type: 'celiador/phoneCommand',
			telemetryClientVersion: 'celiador-editor 1.138.0',
			receivedAt: '2026-10-18T10:00:00.000Z',
			payload: {
				'TelemetryDeck.AppInfo.version': '1.138.0',
				'TelemetryDeck.AppInfo.buildNumber': '0123456789',
				'TelemetryDeck.Device.platform': 'Mac',
				'TelemetryDeck.Device.systemVersion': '26.1',
				'TelemetryDeck.Device.architecture': 'arm64',
				command: 'git.pr',
				count: '2',
			},
		});
	});

	test('core error event: only the allowlisted keys survive, trusted values are unwrapped', () => {
		const signal = buildTelemetryDeckSignal('UnhandledError', {
			uncaught_error_name: { value: 'TypeError', isTrustedTelemetryValue: true },
			count: 3,
			msg: 'secret message',
			callstack: 'at /Users/someone/project/file.ts:1',
			file: '/Users/someone/project/file.ts',
		}, { ...context, commit: undefined, isTestMode: true });
		assert.deepStrictEqual(signal, {
			clientUser: 'hashed-user',
			sessionID: 'session-1',
			appID: 'app-1',
			type: 'UnhandledError',
			telemetryClientVersion: 'celiador-editor 1.138.0',
			receivedAt: '2026-10-18T10:00:00.000Z',
			isTestMode: true,
			payload: {
				'TelemetryDeck.AppInfo.version': '1.138.0',
				uncaught_error_name: 'TypeError',
				count: '3',
			},
		});
	});

	test('events off the allowlist produce no signal', () => {
		assert.strictEqual(buildTelemetryDeckSignal('editorOpened', { 'common.platform': 'Mac' }, context), undefined);
	});
});
