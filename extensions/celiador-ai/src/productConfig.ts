/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getRestrictedSetting } from './config';

// Per-channel defaults come from the build's product.json (dev/test/prod builds
// ship different values — CHANNELS.md), while the `celiador.daemonUrl` setting
// lets an individual user override without a rebuild. Reading product.json keeps
// the dev/test/prod split in one place — the build identity — instead of
// scattered hardcoded URLs. See daemon/ENVIRONMENTS.md.

const FALLBACK_DAEMON_URL = 'https://celiador.ai';
const FALLBACK_URL_PROTOCOL = 'celiador';

interface ProductChannelFields {
	celiadorDaemonUrl?: string;
	urlProtocol?: string;
}

let productCache: ProductChannelFields | null | undefined;

/** Read the fork's product.json once (extension host runs in Node). */
function product(): ProductChannelFields {
  if (productCache !== undefined) {return productCache ?? {};}
  try {
    const file = path.join(vscode.env.appRoot, 'product.json');
    productCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    productCache = null;
  }
  return productCache ?? {};
}

/**
 * Resolve the daemon base URL for this build.
 * Order: explicit user-scope `celiador.daemonUrl` setting → product.json `celiadorDaemonUrl`
 * → hardcoded prod fallback. Trailing slashes are stripped.
 */
export function resolveDaemonUrl(): string {
  // User/global scope only — a workspace must not be able to redirect the token.
  const setting = getRestrictedSetting<string>('daemonUrl', '');
  const url = setting || product().celiadorDaemonUrl || FALLBACK_DAEMON_URL;
  return url.replace(/\/+$/, '');
}

/**
 * The URL scheme this build registers (`celiador`, `celiador-test`,
 * `celiador-dev`), so deep links return to the channel's own app.
 */
export function resolveUrlProtocol(): string {
  return product().urlProtocol || FALLBACK_URL_PROTOCOL;
}
