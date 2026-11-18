/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';

/**
 * Celiador: the user's daemon override, contributed by the celiador-ai extension
 * (application scope, restricted). The extension's `resolveDaemonUrl`
 * (`extensions/celiador-ai/src/productConfig.ts`) applies the same rule, so the
 * relay, the presence heartbeat, the editor control and the extension always talk
 * to the same daemon.
 */
export const CELIADOR_DAEMON_URL_SETTING = 'celiador.daemonUrl';

/** Celiador: the daemon when neither the setting nor `product.celiadorDaemonUrl` names one. */
const FALLBACK_DAEMON_URL = 'https://celiador.ai';

/**
 * Celiador: the daemon base URL (no trailing slash) the workbench talks to: the
 * user's `celiador.daemonUrl` setting, else the build's `celiadorDaemonUrl`, else
 * prod. Only the user (or application) value counts, never a workspace's, so a
 * repository cannot send the user's token elsewhere. Read on every request, so a
 * changed setting applies to the next one.
 */
export function getCeliadorDaemonUrl(productService: IProductService, configurationService: IConfigurationService): string {
	const inspected = configurationService.inspect<string>(CELIADOR_DAEMON_URL_SETTING);
	const override = inspected.applicationValue ?? inspected.userValue;
	const url = (typeof override === 'string' ? override.trim() : '') || productService.celiadorDaemonUrl || FALLBACK_DAEMON_URL;
	return url.replace(/\/+$/, '');
}
