/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { CeliadorRelayClient, relayReconnectDelay, summarizeRelayToolInput } from '../../../../browser/agentSessions/agentHost/celiadorRelayClient.js';

suite('CeliadorRelayToolInput', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes only a path, command or pattern', () => {
		const long = 'x'.repeat(300);
		assert.deepStrictEqual([
			summarizeRelayToolInput('Read', JSON.stringify({ file_path: '/wt/app/SessionView.swift', limit: 20 }), '/wt'),
			summarizeRelayToolInput('Write', JSON.stringify({ file_path: '/elsewhere/a.ts', content: 'secret' }), '/wt'),
			summarizeRelayToolInput('Bash', JSON.stringify({ command: 'npm test -- relay', description: 'run' }), '/wt'),
			summarizeRelayToolInput('Grep', JSON.stringify({ pattern: 'TODO', path: '/wt/src' }), '/wt'),
			summarizeRelayToolInput('Bash', JSON.stringify({ command: long }), '/wt').command?.length,
			summarizeRelayToolInput('Edit', 'not json', '/wt'),
			summarizeRelayToolInput('WebFetch', JSON.stringify({ url: 'https://x', prompt: 'p' }), '/wt'),
			// The Claude host's own shapes for shell / search tools: the bare string.
			summarizeRelayToolInput('Bash', 'git add greet.js README.md', '/wt'),
			summarizeRelayToolInput('Glob', '**/*.ts', '/wt'),
		], [
			{ path: 'app/SessionView.swift' },
			{ path: '/elsewhere/a.ts' },
			{ command: 'npm test -- relay' },
			{ pattern: 'TODO' },
			200,
			{},
			{},
			{ command: 'git add greet.js README.md' },
			{ pattern: '**/*.ts' },
		]);
	});
});

suite('CeliadorRelayClient', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** An SSE body that sends `frames`, then stays open until the request is aborted. */
	function sse(signal: AbortSignal | null | undefined, frames: string[]): Response {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) {
					controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
				}
				signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
			},
		});
		return new Response(body, { status: 200 });
	}

	/**
	 * A fake daemon. `commands` answers each GET of a command channel in turn
	 * (404 = the daemon forgot the session; a list = SSE frames); `onRequest`
	 * sees every request as `METHOD path`.
	 */
	function daemon(commands: (number | string[])[], onRequest: (request: string) => void = () => { }) {
		const requests: string[] = [];
		const posted: unknown[] = [];
		let sessions = 0;
		const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const path = String(input).replace('https://daemon.test', '');
			const request = `${init?.method ?? 'GET'} ${path}`;
			requests.push(request);
			onRequest(request);
			if (path === '/api/sessions') {
				return Response.json({ session: { id: `s${++sessions}` } });
			}
			if (path.endsWith('/events')) {
				posted.push(...JSON.parse(String(init?.body)));
				return new Response(null, { status: 204 });
			}
			const next = commands.shift() ?? [];
			return typeof next === 'number' ? new Response(null, { status: next }) : sse(init?.signal, next);
		};
		return { requests, posted, fetch: fakeFetch as typeof fetch };
	}

	test('reconnect delays grow exponentially with jitter, capped at 30 s', () => {
		assert.deepStrictEqual(
			[0, 1, 2, 3, 4, 5, 6, 20].map(attempt => [relayReconnectDelay(attempt, 0), relayReconnectDelay(attempt, 0.999)]),
			[[500, 1000], [1000, 1999], [2000, 3998], [4000, 7996], [8000, 15992], [15000, 29985], [15000, 29985], [15000, 29985]],
		);
	});

	test('creates the session again when the daemon forgot it, and keeps taking commands', () => runWithFakedTimers({}, async () => {
		const instructed = new DeferredPromise<string>();
		const fake = daemon([404, [JSON.stringify({ kind: 'instruct', text: 'carry on' })]]);
		const client = store.add(new CeliadorRelayClient({
			getUrl: () => 'https://daemon.test',
			getToken: async () => 'token',
			onInstruct: text => instructed.complete(text),
			fetch: fake.fetch,
			random: () => 0,
		}));
		client.publish({ kind: 'state', state: 'running' });
		await client.start('Fix the login bug', 'task-1', 'ahp-session:/s');
		const text = await instructed.p;

		assert.deepStrictEqual({ text, session: client.sessionId, requests: fake.requests, posted: fake.posted }, {
			text: 'carry on',
			session: 's2',
			requests: [
				'POST /api/sessions',
				'GET /api/sessions/s1/commands',
				'POST /api/sessions/s1/events',
				'POST /api/sessions',
				'GET /api/sessions/s2/commands',
				'POST /api/sessions/s2/events',
			],
			posted: [{ kind: 'state', state: 'running' }, { kind: 'state', state: 'running' }],
		});
	}));

	test('drops a command channel that has gone silent and opens a new one', () => runWithFakedTimers({}, async () => {
		const reopened = new DeferredPromise<void>();
		let opened = 0;
		const fake = daemon([[], []], request => {
			if (request.endsWith('/commands') && ++opened === 2) {
				reopened.complete();
			}
		});
		const client = store.add(new CeliadorRelayClient({
			getUrl: () => 'https://daemon.test',
			getToken: async () => 'token',
			fetch: fake.fetch,
			random: () => 0,
		}));
		await client.start('Quiet run');
		const before = Date.now();
		await reopened.p;

		assert.deepStrictEqual({ waited: Date.now() - before, requests: fake.requests }, {
			waited: 45_000 + 500,
			requests: ['POST /api/sessions', 'GET /api/sessions/s1/commands', 'GET /api/sessions/s1/commands'],
		});
	}));
});
