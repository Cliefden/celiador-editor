/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';

// Path checks for the paths the phone sends with relayed git commands. Kept free
// of the `vscode` module so the unit tests can load them.

/**
 * The segments of a repo-relative path from the phone. Rejects `..` escapes and
 * backslashes (a Windows path separator), and anything inside `.git`, matched
 * without case or trailing dots and spaces as case-insensitive file systems do.
 */
export function relaySegments(rel: string): string[] {
  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  for (const s of segments) {
    const name = s.toLowerCase().replace(/[. ]+$/, '');
    if (s === '..' || name === '' || /[\\\0]/.test(s)) {throw new Error('bad path');}
    if (name === '.git') {throw new Error('the phone cannot access this path');}
  }
  return segments;
}

/** Whether the resolved absolute path `child` is `parent` or lies inside it. */
export function isInside(parent: string, child: string, sep: string = path.sep): boolean {
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(base);
}
