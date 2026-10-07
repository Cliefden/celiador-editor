/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Celiador: LSP-backed workspace-symbol search for the agent (docs/CODEBASE_CONTEXT.md,
// option A). Lets the agent jump to a definition by name instead of grepping for it.

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Location } from '../../../../../editor/common/languages.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { getWorkspaceSymbols, IWorkspaceSymbol, WorkspaceSymbolProviderRegistry } from '../../../search/common/search.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/tools/languageModelToolsService.js';
import { createToolSimpleTextResult } from '../../common/tools/builtinTools/toolHelpers.js';
import { errorResult, isSymbolToolResourceInScope } from './toolHelpers.js';

export const WorkspaceSymbolsToolId = 'vscode_searchWorkspaceSymbols';

const DefaultMaxResults = 50;
const MaxMaxResults = 200;

/** Model-facing names, indexed by `SymbolKind` (a const enum, so it has no reverse map). */
const symbolKindNames: readonly string[] = [
	'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
	'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
	'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter',
];

const ModelDescription = `Search the workspace for symbol definitions (classes, functions, methods, interfaces, types, variables, etc.) by name, using the language servers' index. Faster and more precise than a text search when you know (part of) a symbol's name and want to find where it is defined.

Input:
- "query": The symbol name or a fragment of it. Matching is fuzzy (e.g. "getWsSym" can match "getWorkspaceSymbols").
- "maxResults": Optional cap on the number of results (default ${DefaultMaxResults}, max ${MaxMaxResults}).

Returns one line per symbol: kind, name, container, file URI and 1-based line. Only languages whose extension provides workspace symbols are covered; fall back to a text search when nothing is found.`;

interface IWorkspaceSymbolsToolInput {
	readonly query: string;
	readonly maxResults?: number;
}

export class WorkspaceSymbolsTool extends Disposable implements IToolImpl {

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
	) {
		super();
	}

	getToolData(): IToolData {
		return {
			id: WorkspaceSymbolsToolId,
			toolReferenceName: 'workspaceSymbols',
			canBeReferencedInPrompt: false,
			icon: ThemeIcon.fromId(Codicon.symbolClass.id),
			displayName: localize('tool.workspaceSymbols.displayName', 'Search Workspace Symbols'),
			userDescription: localize('tool.workspaceSymbols.userDescription', 'Find symbol definitions in the workspace by name'),
			modelDescription: ModelDescription,
			source: ToolDataSource.Internal,
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The symbol name, or a fragment of it, to search for.'
					},
					maxResults: {
						type: 'number',
						description: `Maximum number of results to return (default ${DefaultMaxResults}, max ${MaxMaxResults}).`
					}
				},
				required: ['query']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const input = context.parameters as IWorkspaceSymbolsToolInput;
		return {
			invocationMessage: localize('tool.workspaceSymbols.invocationMessage', 'Searching workspace symbols for `{0}`', input.query),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const input = invocation.parameters as IWorkspaceSymbolsToolInput;
		const query = typeof input.query === 'string' ? input.query.trim() : '';
		if (!query) {
			return errorResult('Provide a non-empty "query" (a symbol name or fragment).');
		}
		if (WorkspaceSymbolProviderRegistry.all().length === 0) {
			return errorResult('No workspace symbol provider is available (no language extension for this workspace provides one yet). Use a text search instead.');
		}

		const maxResults = Math.min(Math.max(Math.floor(input.maxResults ?? DefaultMaxResults), 1), MaxMaxResults);
		const workingDirectory = invocation.context?.workingDirectory;
		const items = await getWorkspaceSymbols(query, token);
		const symbols = items
			.map(item => item.symbol)
			.filter(symbol => isSymbolToolResourceInScope(symbol.location.uri, this._workspaceContextService, this._uriIdentityService, workingDirectory));

		if (symbols.length === 0) {
			const result = createToolSimpleTextResult(`No workspace symbols found for \`${query}\`.`);
			result.toolResultMessage = new MarkdownString(localize('tool.workspaceSymbols.noResults', 'Searched workspace symbols for `{0}`, no results', query));
			return result;
		}

		const shown = symbols.slice(0, maxResults);
		const lines = [symbols.length > shown.length
			? `${symbols.length} symbols match \`${query}\`; showing the first ${shown.length}:\n`
			: `${symbols.length} symbols match \`${query}\`:\n`];
		for (const symbol of shown) {
			lines.push(formatSymbol(symbol));
		}

		const result = createToolSimpleTextResult(lines.join('\n'));
		result.toolResultMessage = symbols.length === 1
			? new MarkdownString(localize('tool.workspaceSymbols.oneResult', 'Searched workspace symbols for `{0}`, 1 result', query))
			: new MarkdownString(localize('tool.workspaceSymbols.results', 'Searched workspace symbols for `{0}`, {1} results', query, symbols.length));
		result.toolResultDetails = shown.map((s): Location => ({ uri: s.location.uri, range: s.location.range }));
		return result;
	}
}

function formatSymbol(symbol: IWorkspaceSymbol): string {
	const kind = symbolKindNames[symbol.kind] ?? 'symbol';
	const container = symbol.containerName ? ` container="${symbol.containerName}"` : '';
	const line = Range.lift(symbol.location.range).startLineNumber;
	return `<symbol kind="${kind}" name="${symbol.name}"${container} uri="${symbol.location.uri.toString()}" line="${line}" />`;
}

export class WorkspaceSymbolsToolContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.workspaceSymbolsTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const tool = this._store.add(instantiationService.createInstance(WorkspaceSymbolsTool));
		this._store.add(toolsService.registerTool(tool.getToolData(), tool));
	}
}
