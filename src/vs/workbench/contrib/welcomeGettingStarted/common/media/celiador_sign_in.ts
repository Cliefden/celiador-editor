/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Media pane of the "Sign in to Celiador" walkthrough step.

import { escape } from '../../../../../base/common/strings.js';
import { localize } from '../../../../../nls.js';

export default () => `
<h3>${escape(localize('celiadorSignIn.what', "One account, three places"))}</h3>
<ul>
	<li>${escape(localize('celiadorSignIn.agent', "The Claude agent in this editor runs on Celiador's key through Celiador's server. There is no API key to paste."))}</li>
	<li>${escape(localize('celiadorSignIn.phone', "The Celiador iPhone app shows the same runs: what needs you, the diff, and a merge button."))}</li>
	<li>${escape(localize('celiadorSignIn.loop', "Label a GitHub issue \"celiador\" and a run starts on this Mac and ends in a pull request."))}</li>
</ul>
<h3>${escape(localize('celiadorSignIn.how', "How to sign in"))}</h3>
<p>${escape(localize('celiadorSignIn.methods', "Email and password (create the account right here, no confirmation mail), a magic link sent to your inbox, or GitHub where the server offers it. The sign-in also lives in the status bar and in the Account view of the chat sidebar."))}</p>
<p>${escape(localize('celiadorSignIn.data', "Your code stays on this Mac. The server relays the model calls and meters usage against the limits published on celiador.ai."))}</p>
`;
// --- End Celiador ---
