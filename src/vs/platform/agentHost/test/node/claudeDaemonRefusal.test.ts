/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { describeDaemonRefusal } from '../../node/claude/claudeDaemonRefusal.js';

suite('claudeDaemonRefusal', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns the SDK\'s API Error text for a daemon refusal into the daemon\'s sentence', () => {
		const envelope = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message }, request_id: null });
		assert.deepStrictEqual({
			plan: describeDaemonRefusal(`API Error: 403 ${envelope('permission_error', 'Your plan doesn\'t include the Celiador agent.')}`),
			quota: describeDaemonRefusal(`API Error: 429 ${envelope('rate_limit_error', 'Daily request limit reached.')}`),
			capacity: describeDaemonRefusal(`API Error: 503 ${envelope('overloaded_error', 'Plan check unavailable.')}`),
			legacyBody: describeDaemonRefusal('API Error: 429 {"error":"Rate limit: too many agent requests per minute."}'),
			signedOut: describeDaemonRefusal(`API Error: 401 ${envelope('authentication_error', 'unauthorized')}`),
			trailingNewline: describeDaemonRefusal(`API Error: 403 ${envelope('permission_error', 'No.')}\n`),
		}, {
			plan: 'Your plan doesn\'t include the Celiador agent.',
			quota: 'Daily request limit reached.',
			capacity: 'Plan check unavailable.',
			legacyBody: 'Rate limit: too many agent requests per minute.',
			signedOut: 'Your Celiador sign-in is no longer valid. Sign in again to keep using the agent.',
			trailingNewline: 'No.',
		});
	});

	test('leaves everything else to the generic error path', () => {
		assert.deepStrictEqual([
			describeDaemonRefusal('API Error: 500 {"type":"error","error":{"type":"api_error","message":"boom"}}'),
			describeDaemonRefusal('API Error: 403 not json'),
			describeDaemonRefusal('API Error: 403 {"error":{"type":"permission_error"}}'),
			describeDaemonRefusal('Something else entirely'),
			describeDaemonRefusal(''),
		], [undefined, undefined, undefined, undefined, undefined]);
	});
});
// --- End Celiador ---
