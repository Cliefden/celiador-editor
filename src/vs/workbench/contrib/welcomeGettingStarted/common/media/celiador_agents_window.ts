/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Media pane of the "Run agents side by side" walkthrough step.

import { escape } from '../../../../../base/common/strings.js';
import { localize } from '../../../../../nls.js';

export default () => `
<h3>${escape(localize('celiadorAgentsWindow.what', "The Agents window"))}</h3>
<ul>
	<li>${escape(localize('celiadorAgentsWindow.parallel', "Several agent sessions at once, each in its own git worktree, so your checkout stays untouched while they work."))}</li>
	<li>${escape(localize('celiadorAgentsWindow.issues', "Runs started from GitHub issues appear here too: label an issue \"celiador\" on a watched repository and follow the run as it opens a pull request."))}</li>
	<li>${escape(localize('celiadorAgentsWindow.phone', "The Celiador iPhone app mirrors every session: answer a question, allow a command, read the diff and merge from anywhere."))}</li>
</ul>
<p>${escape(localize('celiadorAgentsWindow.open', "Open it any time from the Command Palette: \"Open Agents Window\"."))}</p>
`;
// --- End Celiador ---
