/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ExtUri, extUriBiasedIgnorePathCase } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { SymbolKind } from '../../../../../../editor/common/languages.js';
import { IUriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceSymbol, WorkspaceSymbolProviderRegistry } from '../../../../search/common/search.js';
import { WorkspaceSymbolsTool } from '../../../browser/tools/workspaceSymbolsTool.js';
import { IToolInvocation, IToolResult, IToolResultTextPart, ToolProgress } from '../../../common/tools/languageModelToolsService.js';

function getTextContent(result: IToolResult): string {
	const part = result.content.find((p): p is IToolResultTextPart => p.kind === 'text');
	return part?.value ?? '';
}

suite('WorkspaceSymbolsTool', () => {

	const disposables = new DisposableStore();
	const uriIdentityService = { extUri: new ExtUri(() => false) } as Partial<IUriIdentityService> as IUriIdentityService;
	const folderUri = URI.parse('file:///test');
	const folder = { uri: folderUri, toResource: (p: string) => URI.parse(`file:///test/${p}`) } as unknown as IWorkspaceFolder;
	const workspaceService = {
		_serviceBrand: undefined,
		getWorkspace: () => ({ folders: [folder] }),
		getWorkspaceFolder: (uri: URI) => extUriBiasedIgnorePathCase.isEqualOrParent(uri, folderUri) ? folder : null,
	} as unknown as IWorkspaceContextService;

	const noopCountTokens = async () => 0;
	const noopProgress: ToolProgress = { report() { } };

	function symbol(name: string, kind: SymbolKind, path: string, line: number, containerName?: string): IWorkspaceSymbol {
		return { name, kind, containerName, location: { uri: URI.parse(path), range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 10 } } };
	}

	function registerSymbols(symbols: IWorkspaceSymbol[]): void {
		disposables.add(WorkspaceSymbolProviderRegistry.register({
			provideWorkspaceSymbols: query => symbols.filter(s => s.name.toLowerCase().includes(query.toLowerCase())),
		}));
	}

	async function run(parameters: Record<string, unknown>): Promise<IToolResult> {
		const tool = disposables.add(new WorkspaceSymbolsTool(workspaceService, uriIdentityService));
		return tool.invoke({ parameters } as unknown as IToolInvocation, noopCountTokens, noopProgress, CancellationToken.None);
	}

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists in-workspace symbol definitions with kind, container and line', async () => {
		registerSymbols([
			symbol('add', SymbolKind.Function, 'file:///test/math.ts', 3),
			symbol('addAll', SymbolKind.Method, 'file:///test/util.ts', 12, 'Calculator'),
			symbol('addOutside', SymbolKind.Function, 'file:///elsewhere/lib.ts', 1),
			symbol('subtract', SymbolKind.Function, 'file:///test/math.ts', 7),
		]);

		const result = await run({ query: 'add' });

		assert.deepStrictEqual(getTextContent(result).split('\n'), [
			'2 symbols match `add`:', '',
			'<symbol kind="function" name="add" uri="file:///test/math.ts" line="3" />',
			'<symbol kind="method" name="addAll" container="Calculator" uri="file:///test/util.ts" line="12" />',
		]);
	});

	test('caps results at maxResults', async () => {
		registerSymbols([
			symbol('a1', SymbolKind.Variable, 'file:///test/a.ts', 1),
			symbol('a2', SymbolKind.Variable, 'file:///test/a.ts', 2),
			symbol('a3', SymbolKind.Variable, 'file:///test/a.ts', 3),
		]);

		const result = await run({ query: 'a', maxResults: 2 });

		assert.deepStrictEqual(getTextContent(result).split('\n')[0], '3 symbols match `a`; showing the first 2:');
		assert.strictEqual(Array.isArray(result.toolResultDetails) ? result.toolResultDetails.length : -1, 2);
	});

	test('reports when there is no provider or no match', async () => {
		const noProvider = await run({ query: 'add' });
		registerSymbols([symbol('add', SymbolKind.Function, 'file:///test/math.ts', 3)]);
		const noMatch = await run({ query: 'zzz' });

		assert.deepStrictEqual([getTextContent(noProvider).startsWith('No workspace symbol provider'), getTextContent(noMatch)], [
			true,
			'No workspace symbols found for `zzz`.',
		]);
	});
});
