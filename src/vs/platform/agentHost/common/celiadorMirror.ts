/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Celiador: the one identity an agent session has towards the daemon. The relay
// bridge (workbench) creates the phone's mirror of a session under this key, and
// the daemon proxy (agent host) stamps the same key on every gateway request of
// that session, so the daemon can attribute the run's usage (cost per run,
// stand-out contract §1) to the mirror it already shows on the phone. Both
// sides derive it here, from the backend agent-host session URI
// (`ahp-session:/<id>`), so they cannot drift apart.

import { URI } from '../../../base/common/uri.js';

/** The request header the daemon proxy adds; the daemon maps its value to a relay session via `findMirror`. */
export const CELIADOR_MIRROR_HEADER = 'x-celiador-mirror';

/** The mirror key of an agent session: its backend agent-host session URI as a string. */
export function celiadorMirrorKey(backendSession: URI): string {
	return backendSession.toString();
}
// --- End Celiador ---
