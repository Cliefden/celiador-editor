/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/**
 * Celiador: user settings that builds from September 2026 wrote and nothing reads
 * any more. Each entry says when the key is removed.
 */
const LEGACY_SETTINGS: readonly { readonly key: string; readonly remove: (value: unknown) => boolean }[] = [
	// Hid the core chat view and composer (chatSetupHidden). Celiador has no
	// Copilot setup flow to undo it, so the right-hand chat pane lost its input.
	{ key: 'chat.disableAIFeatures', remove: value => value === true },
	// Legacy provider choice; the daemon picks the model now.
	{ key: 'celiador.provider', remove: value => value !== undefined },
	// An auth token in plaintext. Sign-in now lives in SecretStorage.
	{ key: 'celiador.token', remove: value => value !== undefined },
];

/**
 * Celiador: removes {@link LEGACY_SETTINGS} from the local user settings once per
 * profile. One-time, so a user who later sets `chat.disableAIFeatures` on purpose
 * keeps it. A failed write leaves the migration to run again next start.
 */
export class CeliadorLegacySettingsMigration extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.celiadorLegacySettingsMigration';
	static readonly STORAGE_KEY = 'celiador.legacySettingsMigrated';

	/** Settles once the migration has run (or was already done). */
	readonly whenDone: Promise<void>;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this.whenDone = this._migrate();
	}

	private async _migrate(): Promise<void> {
		if (this._storageService.getBoolean(CeliadorLegacySettingsMigration.STORAGE_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		for (const { key, remove } of LEGACY_SETTINGS) {
			if (!remove(this._configurationService.inspect(key).userLocalValue)) {
				continue;
			}
			try {
				await this._configurationService.updateValue(key, undefined, ConfigurationTarget.USER_LOCAL);
				this._logService.info(`[celiador] removed legacy user setting ${key}`);
			} catch (error) {
				// Never log the value: celiador.token is a credential.
				this._logService.warn(`[celiador] could not remove legacy user setting ${key}; will retry next start`, error instanceof Error ? error.message : String(error));
				return;
			}
		}
		this._storageService.store(CeliadorLegacySettingsMigration.STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}
