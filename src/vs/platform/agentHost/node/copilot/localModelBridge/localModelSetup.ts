/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Split out of localModelSetupService.ts so the Agent Host bootstrap can register
// the null service without loading the real one: its import graph reaches
// shim/copilotRequestHandler.ts, which extends `CopilotRequestHandler` from
// `@github/copilot-sdk` at module load. That SDK is GitHub-proprietary and not
// shipped in Celiador, so loading it would crash the Agent Host on startup.
// localModelSetupService.ts re-exports everything here, so upstream importers
// are unchanged.
// --- End Celiador ---

import { createDecorator } from '../../../../instantiation/common/instantiation.js';
import type { ILocalModelProvider, LocalModelProviderSelection } from './localModelProvider.js';

export const ILocalModelSetupService = createDecorator<ILocalModelSetupService>('localModelSetupService');

/**
 * Owns the single {@link ILocalModelProvider} of this Agent Host process and its setup channel. Only the local
 * utility-process host gets `LocalModelSetupService`; every other host gets {@link NullLocalModelSetupService},
 * so remote hosts publish no status.
 */
export interface ILocalModelSetupService {
	readonly _serviceBrand: undefined;

	/** True only in the local utility-process Agent Host; an input to provider selection. */
	readonly isLocalAgentHost: boolean;

	/** The provider currently owned by this process, if any. */
	readonly provider: ILocalModelProvider | undefined;

	/** Applies the provider selection made at client start: `shim` creates the provider and channel once and keeps them across restarts; `none` disposes them. Returns the provider to install. */
	applySelection(selection: LocalModelProviderSelection): ILocalModelProvider | undefined;
}

/** {@link ILocalModelSetupService} for hosts without on-device model support. */
export class NullLocalModelSetupService implements ILocalModelSetupService {
	declare readonly _serviceBrand: undefined;
	readonly isLocalAgentHost = false;
	readonly provider = undefined;

	applySelection(_selection: LocalModelProviderSelection): undefined {
		return undefined;
	}
}
