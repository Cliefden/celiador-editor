/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Media pane of the "Bring your settings from Cursor or VS Code" walkthrough step.

import { escape } from '../../../../../base/common/strings.js';
import { localize } from '../../../../../nls.js';

export default () => `
<h3>${escape(localize('celiadorImport.what', "What comes across"))}</h3>
<ul>
	<li>${escape(localize('celiadorImport.settings', "Settings, keybindings and snippets, merged into your Celiador profile. Nothing of yours here is overwritten without a value from the other editor."))}</li>
	<li>${escape(localize('celiadorImport.extensions', "Extensions, installed again from Open VSX. Ones that exist only in the other editor's marketplace are listed afterwards so you can look for a replacement."))}</li>
</ul>
<h3>${escape(localize('celiadorImport.notWhat', "What stays behind"))}</h3>
<p>${escape(localize('celiadorImport.dropped', "The other editor's own AI layer (its settings and extensions) and its update or telemetry settings. Celiador has its own agent, so they would only conflict."))}</p>
<p>${escape(localize('celiadorImport.later', "You can run this any time later: Command Palette → \"Celiador: Import Settings from Another Editor\"."))}</p>
`;
// --- End Celiador ---
