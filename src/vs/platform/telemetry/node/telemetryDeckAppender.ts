/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'crypto';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { streamToBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isObject } from '../../../base/common/types.js';
import { ILogService } from '../../log/common/log.js';
import { IRequestService, NO_FETCH_TELEMETRY } from '../../request/common/request.js';
import { ITelemetryAppender } from '../common/telemetryUtils.js';

/**
 * Celiador: product telemetry via TelemetryDeck (https://telemetrydeck.com).
 *
 * An {@link ITelemetryAppender} that sits beside VS Code's telemetry log appender
 * in the shared process, so the standard `telemetry.telemetryLevel` setting and
 * the first-launch notice gate it like any other appender.
 *
 * Deliberately NOT a firehose: only allowlisted events are forwarded (Celiador's
 * own `celiador/*` events, plus unhandled-error counts) and, per event, only the
 * allowlisted payload keys — never paths, stacks, messages or workspace names.
 * The client user is the machine id, SHA-256 hashed with a salt before it leaves
 * the machine (the scheme TelemetryDeck's own SDKs use), so the server never
 * holds a reversible identifier. Signals are batched and sent best-effort
 * through the request service (proxy aware); failures are logged and dropped.
 */

/** TelemetryDeck's v2 ingest body: one element per signal. */
export interface ITelemetryDeckSignal {
	readonly clientUser: string;
	readonly sessionID: string;
	readonly appID: string;
	readonly type: string;
	readonly telemetryClientVersion: string;
	readonly receivedAt: string;
	readonly isTestMode?: boolean;
	readonly payload: Record<string, string>;
}

export interface ITelemetryDeckOptions {
	/** The TelemetryDeck app id signals are filed under. */
	readonly appId: string;
	/** Mixed into the machine id before hashing. */
	readonly salt?: string;
	/** Ingest URL; defaults to TelemetryDeck's public v2 endpoint. */
	readonly target?: string;
	readonly machineId: string;
	readonly appVersion: string;
	readonly commit?: string;
	/** Marks signals as test data (non-stable builds), kept out of the production dashboard. */
	readonly isTestMode: boolean;
}

/** What {@link buildTelemetryDeckSignal} needs to know about the sending app. */
export interface ITelemetryDeckSignalContext {
	readonly appId: string;
	readonly clientUser: string;
	readonly sessionId: string;
	readonly appVersion: string;
	readonly commit?: string;
	readonly isTestMode: boolean;
	readonly receivedAt: string;
}

const DEFAULT_TARGET = 'https://nom.telemetrydeck.com/v2/';
const CLIENT_NAME = 'celiador-editor';
const OWN_EVENT_PREFIX = 'celiador/';
const COMMON_PROPERTY_PREFIX = 'common.';

/** Events outside the `celiador/*` namespace that are forwarded, with the payload keys allowed through. */
const ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map([
	['UnhandledError', ['uncaught_error_name', 'count']],
]);

/** VS Code common properties → TelemetryDeck's standard payload keys (everything else under `common.` is dropped). */
const COMMON_TO_TELEMETRYDECK: ReadonlyMap<string, string> = new Map([
	['common.platform', 'TelemetryDeck.Device.platform'],
	['common.platformVersion', 'TelemetryDeck.Device.systemVersion'],
	['common.nodeArch', 'TelemetryDeck.Device.architecture'],
]);

/**
 * Which payload keys of `eventName` may be forwarded: `'all'` for Celiador's own
 * events, an explicit list for the few core events we care about, or undefined
 * when the event is not forwarded at all.
 */
export function allowedPayloadKeys(eventName: string): readonly string[] | 'all' | undefined {
	if (eventName.startsWith(OWN_EVENT_PREFIX)) {
		return 'all';
	}
	return ALLOWLIST.get(eventName);
}

/** The anonymous client user: SHA-256 of the machine id plus salt, hex encoded. */
export function hashClientUser(machineId: string, salt: string): string {
	return createHash('sha256').update(machineId + salt).digest('hex');
}

function asPrimitiveString(value: unknown): string | undefined {
	// Values may arrive wrapped as a serialized TelemetryTrustedValue.
	if (isObject(value)) {
		const trusted = value as { isTrustedTelemetryValue?: boolean; value?: unknown };
		return trusted.isTrustedTelemetryValue ? asPrimitiveString(trusted.value) : undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return undefined;
}

/**
 * Shape one VS Code telemetry event into a TelemetryDeck signal, or undefined
 * when the event is not on the allowlist. Pure, so it can be tested without a
 * request service.
 */
export function buildTelemetryDeckSignal(eventName: string, data: Record<string, unknown> | undefined, context: ITelemetryDeckSignalContext): ITelemetryDeckSignal | undefined {
	const allowed = allowedPayloadKeys(eventName);
	if (!allowed) {
		return undefined;
	}
	const payload: Record<string, string> = {
		'TelemetryDeck.AppInfo.version': context.appVersion,
	};
	if (context.commit) {
		payload['TelemetryDeck.AppInfo.buildNumber'] = context.commit.slice(0, 10);
	}
	for (const [key, raw] of Object.entries(data ?? {})) {
		if (key === 'sessionID') {
			continue; // goes on the envelope, not the payload
		}
		const value = asPrimitiveString(raw);
		if (value === undefined) {
			continue;
		}
		const mapped = COMMON_TO_TELEMETRYDECK.get(key);
		if (mapped) {
			payload[mapped] = value;
			continue;
		}
		if (key.startsWith(COMMON_PROPERTY_PREFIX)) {
			continue;
		}
		if (allowed === 'all' || allowed.includes(key)) {
			payload[key] = value;
		}
	}
	// VS Code's own per-run session id (random, not an account) when present, else ours.
	const sessionID = asPrimitiveString(data?.sessionID) ?? context.sessionId;
	return {
		clientUser: context.clientUser,
		sessionID,
		appID: context.appId,
		type: eventName,
		telemetryClientVersion: `${CLIENT_NAME} ${context.appVersion}`,
		receivedAt: context.receivedAt,
		...(context.isTestMode ? { isTestMode: true } : {}),
		payload,
	};
}

export class TelemetryDeckAppender extends Disposable implements ITelemetryAppender {

	/** How long signals wait for company before a batch goes out. */
	private static readonly FLUSH_DELAY_MS = 10_000;
	/** Oldest signals are dropped past this (telemetry is best-effort, never a memory sink). */
	private static readonly MAX_QUEUE = 200;
	private static readonly MAX_BATCH = 50;

	private readonly _clientUser: string;
	private readonly _sessionId = randomUUID();
	private readonly _target: string;
	private readonly _flushScheduler: RunOnceScheduler;
	private _queue: ITelemetryDeckSignal[] = [];
	private _sending: Promise<void> = Promise.resolve();

	constructor(
		private readonly _options: ITelemetryDeckOptions,
		private readonly _requestService: IRequestService,
		private readonly _logService: ILogService,
	) {
		super();
		this._clientUser = hashClientUser(_options.machineId, _options.salt ?? '');
		this._target = _options.target ?? DEFAULT_TARGET;
		this._flushScheduler = this._register(new RunOnceScheduler(() => { void this.flush(); }, TelemetryDeckAppender.FLUSH_DELAY_MS));
	}

	log(eventName: string, data?: unknown): void {
		const signal = buildTelemetryDeckSignal(eventName, isObject(data) ? data as Record<string, unknown> : undefined, {
			appId: this._options.appId,
			clientUser: this._clientUser,
			sessionId: this._sessionId,
			appVersion: this._options.appVersion,
			commit: this._options.commit,
			isTestMode: this._options.isTestMode,
			receivedAt: new Date().toISOString(),
		});
		if (!signal) {
			return;
		}
		this._queue.push(signal);
		if (this._queue.length > TelemetryDeckAppender.MAX_QUEUE) {
			this._queue.splice(0, this._queue.length - TelemetryDeckAppender.MAX_QUEUE);
		}
		if (!this._flushScheduler.isScheduled()) {
			this._flushScheduler.schedule();
		}
	}

	flush(): Promise<void> {
		this._flushScheduler.cancel();
		this._sending = this._sending.then(() => this._send());
		return this._sending;
	}

	private async _send(): Promise<void> {
		while (this._queue.length > 0) {
			const batch = this._queue.splice(0, TelemetryDeckAppender.MAX_BATCH);
			const body = JSON.stringify(batch);
			try {
				const context = await this._requestService.request({
					type: 'POST',
					url: this._target,
					data: body,
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(body).toString(),
					},
					callSite: NO_FETCH_TELEMETRY,
				}, CancellationToken.None);
				await streamToBuffer(context.stream); // drain; the echo body is not needed
				const status = context.res.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					this._logService.warn(`[telemetrydeck] ingest answered ${status} for ${batch.length} signal(s)`);
				}
			} catch (err) {
				// Dropped on purpose — telemetry must never retry its way into the user's bandwidth.
				this._logService.warn(`[telemetrydeck] send failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}
