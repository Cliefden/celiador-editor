/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import {
	ILoopbackProxyHandle,
	ILoopbackProxyRuntime,
	IProxyInFlight,
	LoopbackProxyServer,
	readProxyRequestBody,
} from '../shared/loopbackProxyServer.js';
import { writeJsonError } from './anthropicErrors.js';
import { parseProxyBearer } from './claudeProxyAuth.js';

// Celiador: the loopback proxy in front of the daemon's Anthropic gateway.
//
// The Claude SDK subprocess reads its credentials from its environment once,
// at startup. The user's Celiador (Supabase) token expires hourly, so pointing
// the subprocess straight at the daemon meant any turn that outlived the token
// — a long run, or one parked on an approval — failed with 401 and no way to
// recover short of restarting it. Routing the subprocess through this proxy
// keeps a per-session nonce in its environment instead; the proxy attaches the
// agent's *current* daemon token to every forwarded request, so a refresh takes
// effect on the next HTTP request, mid-turn included.

// #region Public types

/** What a bind needs: where the daemon gateway is and the token to present. */
export interface ICeliadorDaemonProxySeed {
	/** The daemon's Anthropic gateway, e.g. `https://celiador.ai/api/anthropic`. */
	readonly gatewayUrl: string;
	/** The user's current daemon (Supabase) access token. */
	readonly token: string;
}

/**
 * Refcounted lease on the daemon proxy. `setToken` swaps the token presented
 * to the daemon for every later request without touching the subprocess.
 */
export interface ICeliadorDaemonProxyHandle extends ILoopbackProxyHandle {
	setToken(token: string): void;
}

export interface ICeliadorDaemonProxyService {
	readonly _serviceBrand: undefined;
	/** Start the proxy (if not running) and return a refcounted handle. */
	start(seed: ICeliadorDaemonProxySeed): Promise<ICeliadorDaemonProxyHandle>;
	/** Force-close the proxy regardless of refcount and abort in-flight requests. */
	dispose(): void;
}

export const ICeliadorDaemonProxyService = createDecorator<ICeliadorDaemonProxyService>('celiadorDaemonProxyService');

// #endregion

// #region Implementation

interface ICeliadorDaemonProxyState {
	gatewayUrl: string;
	token: string;
}

const PROXY_USER_FACING_NAME = 'CeliadorDaemonProxyService';

/**
 * Headers that must not cross the proxy in either direction: hop-by-hop
 * headers, the inbound nonce credential (replaced by the daemon token), and
 * framing headers Node rewrites for the re-encoded body.
 */
const DROPPED_HEADERS = new Set([
	'host',
	'authorization',
	'x-api-key',
	'connection',
	'content-length',
	'content-encoding',
	'transfer-encoding',
	'keep-alive',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'upgrade',
	'expect',
]);

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * A transparent pass-through: every authenticated request is forwarded to the
 * same path under the daemon gateway with the current token, and the daemon's
 * response (status, headers, streamed body) is relayed back unchanged. The
 * daemon gateway is itself a full Anthropic-compatible endpoint, so nothing is
 * rewritten here — unlike the Copilot proxy, which translates to CAPI.
 */
export class CeliadorDaemonProxyService extends LoopbackProxyServer<ICeliadorDaemonProxyState, ICeliadorDaemonProxySeed> implements ICeliadorDaemonProxyService {

	declare readonly _serviceBrand: undefined;

	constructor(@ILogService logService: ILogService) {
		super(PROXY_USER_FACING_NAME, logService);
	}

	protected createState(seed: ICeliadorDaemonProxySeed): ICeliadorDaemonProxyState {
		return { gatewayUrl: seed.gatewayUrl.replace(/\/+$/, ''), token: seed.token };
	}

	async start(seed: ICeliadorDaemonProxySeed): Promise<ICeliadorDaemonProxyHandle> {
		const { runtime, release } = await this.acquire(seed);
		// Late-binding update for callers that joined an existing bind.
		runtime.state.gatewayUrl = seed.gatewayUrl.replace(/\/+$/, '');
		runtime.state.token = seed.token;
		return {
			baseUrl: runtime.baseUrl,
			nonce: runtime.nonce,
			setToken: token => { runtime.state.token = token; },
			dispose: release,
		};
	}

	protected override writeInternalError(res: http.ServerResponse): void {
		writeJsonError(res, 500, 'api_error', 'Internal proxy error');
	}

	protected override async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		runtime: ILoopbackProxyRuntime<ICeliadorDaemonProxyState>,
	): Promise<void> {
		const method = req.method ?? 'GET';
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		this._logService.trace(`[${PROXY_USER_FACING_NAME}] ${method} ${url.pathname}`);

		// Health check is the only unauthenticated route.
		if (method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('ok');
			return;
		}

		const auth = parseProxyBearer(req.headers, runtime.nonce);
		if (!auth.valid) {
			writeJsonError(res, 401, 'authentication_error', 'Invalid authentication');
			return;
		}

		let body: string | undefined;
		if (method !== 'GET' && method !== 'HEAD') {
			try {
				body = await readProxyRequestBody(req);
			} catch (err) {
				writeJsonError(res, 400, 'invalid_request_error', `Failed to read request body: ${errorMessage(err)}`);
				return;
			}
		}

		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined || DROPPED_HEADERS.has(name)) {
				continue;
			}
			headers.set(name, Array.isArray(value) ? value.join(', ') : value);
		}
		// The token is read per request, so a refresh applies to the next one.
		headers.set('authorization', `Bearer ${runtime.state.token}`);

		const entry: IProxyInFlight = { ac: new AbortController(), res, clientGone: false };
		runtime.inFlight.add(entry);
		const onClose = () => {
			entry.clientGone = true;
			entry.ac.abort();
		};
		res.on('close', onClose);

		try {
			let upstream: Response;
			try {
				upstream = await fetch(`${runtime.state.gatewayUrl}${url.pathname}${url.search}`, {
					method,
					headers,
					body,
					signal: entry.ac.signal,
				});
			} catch (err) {
				if (!entry.clientGone && !res.headersSent) {
					writeJsonError(res, 502, 'api_error', `Celiador daemon unreachable: ${errorMessage(err)}`);
				}
				return;
			}

			const outHeaders: Record<string, string> = {};
			upstream.headers.forEach((value, name) => {
				if (!DROPPED_HEADERS.has(name)) {
					outHeaders[name] = value;
				}
			});
			res.writeHead(upstream.status, outHeaders);
			if (!upstream.body) {
				res.end();
				return;
			}
			for await (const chunk of upstream.body) {
				if (entry.clientGone) {
					break;
				}
				res.write(chunk);
			}
			if (!entry.clientGone) {
				res.end();
			}
		} catch (err) {
			if (entry.clientGone) {
				return;
			}
			if (!res.headersSent) {
				this.writeInternalError(res);
			} else if (!res.writableEnded) {
				// Mid-stream failure: the status is already out, so cut the socket to
				// signal the SDK rather than leaving it waiting on a truncated body.
				this._logService.warn(`[${PROXY_USER_FACING_NAME}] upstream stream failed: ${errorMessage(err)}`);
				res.destroy();
			}
		} finally {
			res.removeListener('close', onClose);
			runtime.inFlight.delete(entry);
		}
	}
}

// #endregion
