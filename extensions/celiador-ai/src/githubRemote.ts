/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GitHub remote parsing, kept free of the `vscode` module so the unit tests can load it.

/** `owner/repo` from a GitHub remote URL (https or ssh); undefined for other hosts. */
export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) {return undefined;}
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m?.groups ? { owner: m.groups.owner, repo: m.groups.repo } : undefined;
}
