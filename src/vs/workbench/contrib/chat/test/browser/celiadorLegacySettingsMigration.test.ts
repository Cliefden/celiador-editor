/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CeliadorLegacySettingsMigration } from '../../browser/celiadorLegacySettingsMigration.js';

/** Records user-setting writes and applies them, like the real service would. */
class RecordingConfigurationService extends TestConfigurationService {
	readonly writes: { readonly key: string; readonly value: unknown; readonly target: unknown }[] = [];
	failOn: string | undefined;

	override async updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
		if (key === this.failOn) {
			throw new Error('settings.json is read-only');
		}
		this.writes.push({ key, value, target });
		await this.setUserConfiguration(key, value);
	}
}

suite('CeliadorLegacySettingsMigration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function run(configuration: RecordingConfigurationService, storage: InMemoryStorageService): Promise<void> {
		const migration = store.add(new CeliadorLegacySettingsMigration(configuration, storage, new NullLogService()));
		await migration.whenDone;
	}

	test('removes the September-build settings once, and leaves a later deliberate choice alone', async () => {
		const configuration = new RecordingConfigurationService({
			'chat.disableAIFeatures': true,
			'celiador.provider': 'anthropic',
			'celiador.token': 'secret',
			'editor.fontSize': 13,
		});
		const storage = store.add(new InMemoryStorageService());

		await run(configuration, storage);
		const afterFirstStart = configuration.writes.length;
		await configuration.setUserConfiguration('chat.disableAIFeatures', true);
		await run(configuration, storage);

		assert.deepStrictEqual({
			writes: configuration.writes,
			afterFirstStart,
			disableAIFeatures: configuration.getValue('chat.disableAIFeatures'),
			fontSize: configuration.getValue('editor.fontSize'),
		}, {
			writes: [
				{ key: 'chat.disableAIFeatures', value: undefined, target: ConfigurationTarget.USER_LOCAL },
				{ key: 'celiador.provider', value: undefined, target: ConfigurationTarget.USER_LOCAL },
				{ key: 'celiador.token', value: undefined, target: ConfigurationTarget.USER_LOCAL },
			],
			afterFirstStart: 3,
			disableAIFeatures: true,
			fontSize: 13,
		});
	});

	test('keeps chat.disableAIFeatures when it is false and writes nothing for absent keys', async () => {
		const configuration = new RecordingConfigurationService({ 'chat.disableAIFeatures': false });
		const storage = store.add(new InMemoryStorageService());

		await run(configuration, storage);

		assert.deepStrictEqual(configuration.writes, []);
	});

	test('retries on the next start when a removal fails', async () => {
		const configuration = new RecordingConfigurationService({ 'celiador.provider': 'anthropic', 'celiador.token': 'secret' });
		const storage = store.add(new InMemoryStorageService());

		configuration.failOn = 'celiador.token';
		await run(configuration, storage);
		configuration.failOn = undefined;
		await run(configuration, storage);

		assert.deepStrictEqual(configuration.writes.map(write => write.key), ['celiador.provider', 'celiador.token']);
	});
});
