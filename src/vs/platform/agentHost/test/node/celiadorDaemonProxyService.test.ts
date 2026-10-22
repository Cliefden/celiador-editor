/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { CeliadorDaemonProxyService } from '../../node/claude/celiadorDaemonProxyService.js';

// Celiador: the daemon proxy must present the agent's *current* token to the
// daemon on every request, so a token refresh reaches a running turn.

interface IRecordedRequest {
	readonly method: string | undefined;
	readonly url: string | undefined;
	readonly authorization: string | undefined;
	readonly apiKey: string | undefined;
	readonly anthropicVersion: string | undefined;
	readonly body: string;
}

/** A stand-in for `<daemon>/api/anthropic`: records what arrives, answers as told. */
class FakeDaemonGateway {
	readonly requests: IRecordedRequest[] = [];
	status = 200;
	responseBody = '{"id":"msg_1","type":"message"}';
	/** When set, the response is an SSE stream of these frames. */
	sseFrames: string[] | undefined;
	private readonly _server: http.Server;
	baseUrl = '';

	constructor() {
		this._server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', chunk => chunks.push(chunk));
			req.on('end', () => {
				this.requests.push({
					method: req.method,
					url: req.url,
					authorization: req.headers['authorization'],
					apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
					anthropicVersion: typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : undefined,
					body: Buffer.concat(chunks).toString('utf8'),
				});
				if (this.sseFrames) {
					res.writeHead(this.status, { 'Content-Type': 'text/event-stream' });
					for (const frame of this.sseFrames) {
						res.write(frame);
					}
					res.end();
					return;
				}
				res.writeHead(this.status, { 'Content-Type': 'application/json' });
				res.end(this.responseBody);
			});
		});
	}

	async start(): Promise<void> {
		await new Promise<void>(resolve => this._server.listen(0, '127.0.0.1', () => resolve()));
		this.baseUrl = `http://127.0.0.1:${(this._server.address() as AddressInfo).port}/api/anthropic`;
	}

	dispose(): void {
		this._server.closeAllConnections();
		this._server.close();
	}
}

suite('CeliadorDaemonProxyService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(token = 'token-1') {
		const gateway = new FakeDaemonGateway();
		await gateway.start();
		disposables.add(gateway);
		const service = new CeliadorDaemonProxyService(new NullLogService());
		disposables.add(service);
		const handle = await service.start({ gatewayUrl: gateway.baseUrl, token });
		disposables.add(handle);
		return { gateway, service, handle };
	}

	function post(handle: { baseUrl: string; nonce: string }, path: string, body: string, bearer?: string): Promise<{ status: number; body: string }> {
		return fetch(`${handle.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${bearer ?? `${handle.nonce}.session-1`}`,
				'content-type': 'application/json',
				'anthropic-version': '2023-06-01',
				'x-api-key': 'leaked-user-key',
			},
			body,
		}).then(async res => ({ status: res.status, body: await res.text() }));
	}

	test('forwards an authenticated request to the gateway with the daemon token, never the nonce or an API key', async () => {
		const { gateway, handle } = await setup();
		const res = await post(handle, '/v1/messages?beta=true', '{"model":"claude","messages":[]}');
		assert.deepStrictEqual({ res, requests: gateway.requests }, {
			res: { status: 200, body: '{"id":"msg_1","type":"message"}' },
			requests: [{
				method: 'POST',
				url: '/api/anthropic/v1/messages?beta=true',
				authorization: 'Bearer token-1',
				apiKey: undefined,
				anthropicVersion: '2023-06-01',
				body: '{"model":"claude","messages":[]}',
			}],
		});
	});

	test('a refreshed token is presented on the very next request, with no restart', async () => {
		const { gateway, handle } = await setup('token-1');
		await post(handle, '/v1/messages', '{}');
		handle.setToken('token-2');
		await post(handle, '/v1/messages', '{}');
		assert.deepStrictEqual(gateway.requests.map(r => r.authorization), ['Bearer token-1', 'Bearer token-2']);
	});

	test('rejects a request without the proxy nonce before it reaches the gateway', async () => {
		const { gateway, handle } = await setup();
		const res = await post(handle, '/v1/messages', '{}', 'wrong-nonce.session-1');
		assert.deepStrictEqual({ status: res.status, forwarded: gateway.requests.length, type: JSON.parse(res.body).error.type }, { status: 401, forwarded: 0, type: 'authentication_error' });
	});

	test('relays the gateway status and streamed body unchanged', async () => {
		const { gateway, handle } = await setup();
		gateway.status = 429;
		gateway.sseFrames = ['event: error\n', 'data: {"type":"error"}\n\n'];
		const res = await post(handle, '/v1/messages', '{}');
		assert.deepStrictEqual(res, { status: 429, body: 'event: error\ndata: {"type":"error"}\n\n' });
	});

	test('answers 502 when the gateway is unreachable', async () => {
		const { gateway, handle } = await setup();
		gateway.dispose();
		const res = await post(handle, '/v1/messages', '{}');
		assert.deepStrictEqual({ status: res.status, type: JSON.parse(res.body).error.type }, { status: 502, type: 'api_error' });
	});
});
