/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Celiador: which workspace paths the companion phone may reach through the
 * relay's file commands (`fs.list` / `fs.read` / `fs.write`).
 *
 * The phone edits source files. It must not reach the places where a file
 * change makes the desktop run something: git internals and hooks, editor and
 * agent configuration, dev-container and environment loaders.
 */

/** Folders the phone may not write into (matched on any path segment). */
const WRITE_DENIED_FOLDERS = new Set([
	'.git',
	'.vscode',
	'.claude',
	'.devcontainer',
	'.husky',
	'.githooks',
	'.idea',
]);

/** Files the phone may not write (matched on the last path segment). */
const WRITE_DENIED_FILES = new Set([
	'.mcp.json',
	'.envrc',
	'.gitmodules',
]);

/** File extensions the phone may not write. */
const WRITE_DENIED_EXTENSIONS = ['.code-workspace'];

/** Folders the phone may not read from or list. */
const READ_DENIED_FOLDERS = new Set(['.git']);

/**
 * Case-folds a segment and drops trailing dots and spaces, so `.GIT`, `.git.`
 * and `.git ` all match `.git` (case-insensitive and Windows file systems treat
 * them as the same name).
 */
function normalizeSegment(segment: string): string {
	return segment.toLowerCase().replace(/[. ]+$/, '');
}

/**
 * Splits a workspace-relative phone path into its segments. Returns undefined
 * for a path that could leave the root or name something other than a plain
 * relative path: `..`, backslashes (a Windows separator) and NUL bytes.
 */
export function parseRelayPath(rel: string | undefined): string[] | undefined {
	const segments = (rel ?? '').split('/').filter(segment => segment.length > 0 && segment !== '.');
	for (const segment of segments) {
		if (segment === '..' || /[\\\0]/.test(segment) || normalizeSegment(segment) === '') {
			return undefined;
		}
	}
	return segments;
}

/** Whether the phone may not read or list the path with these segments. */
export function isRelayReadDenied(segments: readonly string[]): boolean {
	return segments.some(segment => READ_DENIED_FOLDERS.has(normalizeSegment(segment)));
}

/** Whether the phone may not write the path with these segments. */
export function isRelayWriteDenied(segments: readonly string[]): boolean {
	if (segments.length === 0) {
		return true; // the root itself is not a file
	}
	if (segments.some(segment => WRITE_DENIED_FOLDERS.has(normalizeSegment(segment)))) {
		return true;
	}
	const name = normalizeSegment(segments[segments.length - 1]);
	return WRITE_DENIED_FILES.has(name) || WRITE_DENIED_EXTENSIONS.some(extension => name.endsWith(extension));
}
