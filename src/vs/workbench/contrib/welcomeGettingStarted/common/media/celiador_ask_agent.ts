/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Media pane of the "Ask the agent" walkthrough step.

import { escape } from '../../../../../base/common/strings.js';
import { localize } from '../../../../../nls.js';

export default () => `
<h3>${escape(localize('celiadorAskAgent.try', "Good first asks"))}</h3>
<ul>
	<li><code>${escape(localize('celiadorAskAgent.example1', "Explain this codebase. Where are the entry points and the main modules?"))}</code></li>
	<li><code>${escape(localize('celiadorAskAgent.example2', "Suggest three small, safe improvements and make the first one."))}</code></li>
	<li><code>${escape(localize('celiadorAskAgent.example3', "Write a test for the function I have selected."))}</code></li>
</ul>
<h3>${escape(localize('celiadorAskAgent.how', "How it works"))}</h3>
<p>${escape(localize('celiadorAskAgent.review', "The agent reads and edits files in this workspace and runs commands in its terminal. Routine commands run on their own; a risky one waits for your Allow. Every edit shows up in the Changes view, where you keep or discard it."))}</p>
<p>${escape(localize('celiadorAskAgent.firstRun', "The first message downloads the agent runtime (about a minute). Open a folder first so the agent has something to work in."))}</p>
`;
// --- End Celiador ---
