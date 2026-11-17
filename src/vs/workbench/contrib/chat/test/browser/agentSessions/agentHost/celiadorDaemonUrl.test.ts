/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mock } from '../../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IConfigurationService, IConfigurationValue } from '../../../../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../../../../platform/product/common/productService.js';
import { getCeliadorDaemonUrl } from '../../../../browser/agentSessions/agentHost/celiadorDaemonUrl.js';

suite('CeliadorDaemonUrl', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function resolve(productUrl: string | undefined, setting: Partial<IConfigurationValue<string>>): string {
		const product = { celiadorDaemonUrl: productUrl } as IProductService;
		const configuration = new class extends mock<IConfigurationService>() {
			override inspect<T>(): IConfigurationValue<T> {
				return setting as IConfigurationValue<T>;
			}
		}();
		return getCeliadorDaemonUrl(product, configuration);
	}

	test('the user setting wins over the build, a workspace value never counts', () => {
		assert.deepStrictEqual([
			resolve('https://test.celiador.ai/', {}),
			resolve(undefined, {}),
			resolve('https://celiador.ai', { userValue: ' https://dev.celiador.ai/ ' }),
			resolve('https://celiador.ai', { applicationValue: 'http://localhost:4661' }),
			resolve('https://celiador.ai', { userValue: '' }),
			resolve('https://celiador.ai', { workspaceValue: 'https://evil.example' }),
		], [
			'https://test.celiador.ai',
			'https://celiador.ai',
			'https://dev.celiador.ai',
			'http://localhost:4661',
			'https://celiador.ai',
			'https://celiador.ai',
		]);
	});
});
