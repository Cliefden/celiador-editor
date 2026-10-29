/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// When the Celiador daemon refuses an agent request — plan gate (403), per-user
// quota (429), a sign-in that no longer holds (401), or capacity (503) — the
// Claude SDK reports it as the text `API Error: <status> <json body>`. Shown
// raw, that is a JSON blob in the chat. This turns it back into the daemon's
// own sentence, which already says what to do ("resets at midnight UTC").

import { localize } from '../../../../nls.js';

/** `API Error: 403 {...}` — how the Claude SDK reports a non-2xx from its endpoint. */
const API_ERROR = /^API Error:\s*(?<status>\d{3})\s*(?<body>\{[\s\S]*\})\s*$/;

const REFUSAL_STATUSES = new Set([401, 403, 429, 503]);

/**
 * The daemon's message for a refusal the SDK relayed as `API Error`, or
 * `undefined` when `text` is anything else (left to the generic path).
 */
export function describeDaemonRefusal(text: string): string | undefined {
	const match = API_ERROR.exec(text.trim());
	if (!match?.groups) {
		return undefined;
	}
	const status = Number(match.groups.status);
	if (!REFUSAL_STATUSES.has(status)) {
		return undefined;
	}
	const message = parseRefusalMessage(match.groups.body);
	if (!message) {
		return undefined;
	}
	if (status === 401) {
		// The loopback proxy refreshes the token mid-turn, so a 401 that still
		// reaches the SDK means the account is really signed out.
		return localize('celiador.refusal.signedOut', "Your Celiador sign-in is no longer valid. Sign in again to keep using the agent.");
	}
	return message;
}

/**
 * The message out of an Anthropic error envelope (`{ error: { message } }`,
 * what the daemon sends) or the daemon's older `{ error: "…" }` body.
 */
function parseRefusalMessage(body: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const error = (parsed as { error?: unknown }).error;
	if (typeof error === 'string') {
		return error.trim() || undefined;
	}
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message;
		return typeof message === 'string' && message.trim() ? message.trim() : undefined;
	}
	return undefined;
}
// --- End Celiador ---
