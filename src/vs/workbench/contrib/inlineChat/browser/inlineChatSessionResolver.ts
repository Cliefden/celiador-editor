/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { withChatSurfaceMeta } from '../../../../platform/agentHost/common/meta/agentChatSurfaceMeta.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatModelReference, IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatConfiguration, getLocalFallbackSessionTypeSelectionReason } from '../../chat/common/constants.js';
import { IChatSessionsService, ResolvedChatSessionsExtensionPoint, SessionType } from '../../chat/common/chatSessionsService.js';

export const IInlineChatSessionResolver = createDecorator<IInlineChatSessionResolver>('inlineChatSessionResolver');

/** Result of resolving the chat model used by the editor inline chat surface. */
export interface IInlineChatSessionResolution {
	readonly modelRef: IChatModelReference;
	/**
	 * The chat session contribution the widget must lock to so requests carry
	 * `agentIdSilent` and reach the Agent Host agent instead of the default inline
	 * participant. `undefined` for a local fallback session, which must stay on the
	 * legacy extension-host agent.
	 */
	readonly lockToAgent: ResolvedChatSessionsExtensionPoint | undefined;
}

/** Resolves the chat model reference used by the editor inline chat surface. */
export interface IInlineChatSessionResolver {
	readonly _serviceBrand: undefined;
	resolve(token: CancellationToken, languageId: string | undefined, targetUri: URI): Promise<IInlineChatSessionResolution | undefined>;
}

/** Builds the Agent Host metadata for an editor inline chat session. */
export function getInlineChatSessionMeta(languageId: string | undefined, targetUri: URI): Record<string, unknown> {
	return withChatSurfaceMeta(undefined, { surface: 'editorInline', languageId, targetUri: targetUri.toString() })!;
}

/** Applies editor inline chat-specific Agent Host and local-session fallback policy. */
export class InlineChatSessionResolver implements IInlineChatSessionResolver {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IChatService private readonly _chatService: IChatService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	async resolve(token: CancellationToken, languageId: string | undefined, targetUri: URI): Promise<IInlineChatSessionResolution | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const meta = getInlineChatSessionMeta(languageId, targetUri);
		let modelRef: IChatModelReference | undefined;
		const agentHostEnabled = this._configurationService.getValue<boolean>(ChatConfiguration.InlineChatAgentHostEnabled) === true;
		const sessionType = agentHostEnabled ? this._findInlineAgentHostSessionType() : undefined;
		const contribution = sessionType ? this._chatSessionsService.getChatSessionContribution(sessionType) : undefined;
		if (sessionType) {
			try {
				const item = await this._chatSessionsService.createNewChatSessionItem(sessionType, {
					prompt: '',
					isEphemeral: true,
					_meta: meta,
				}, token);
				modelRef = item && await this._chatService.acquireOrLoadSession(item.resource, ChatAgentLocation.EditorInline, token, 'InlineChatSessionResolver#resolve');
			} catch (error) {
				if (isCancellationError(error) || token.isCancellationRequested) {
					throw error;
				}
				onUnexpectedError(error);
			}
		}

		if (token.isCancellationRequested) {
			modelRef?.dispose();
			return undefined;
		}

		if (modelRef) {
			return { modelRef, lockToAgent: contribution };
		}

		modelRef = this._chatService.startNewLocalSession(ChatAgentLocation.EditorInline, {
			canUseTools: false /* SEE https://github.com/microsoft/vscode/issues/279946 */,
			sessionTypeSelectionReason: sessionType ? getLocalFallbackSessionTypeSelectionReason(sessionType, false) : undefined,
		});
		if (token.isCancellationRequested) {
			modelRef.dispose();
			return undefined;
		}
		return { modelRef, lockToAgent: undefined };
	}

	/**
	 * The first registered Agent Host session type that offers the editor inline
	 * location. Celiador: its agent is the Claude provider, so try Claude before
	 * Copilot CLI (upstream hardcoded Copilot CLI only).
	 */
	private _findInlineAgentHostSessionType(): string | undefined {
		return [SessionType.AgentHostClaude, SessionType.AgentHostCopilot].find(type =>
			this._chatSessionsService.getChatSessionContribution(type)?.locations?.includes(ChatAgentLocation.EditorInline) === true);
	}
}
