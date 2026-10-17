/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { Auth } from './auth';
import { resolveDaemonUrl } from './productConfig';

// Experimental "Tab autocomplete": a model-backed inline-completion provider
// routed through the daemon's /api/complete endpoint (a small, fast Haiku call).
// Off by default — Claude is not a fill-in-the-middle model, so completions are
// best treated as an opt-in convenience, not the headline feature (that is the
// ⌘I inline edit). Gated behind `celiador.inlineCompletions.enabled`.

const MAX_PREFIX = 4000;
const MAX_SUFFIX = 1000;

/** Read the boolean/number setting under the `celiador` section. */
function setting<T>(key: string, fallback: T): T {
  const value = vscode.workspace.getConfiguration('celiador').get<T>(key);
  return value === undefined ? fallback : value;
}

/** Resolve after `ms`, or reject early if the token is cancelled. */
function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(resolve, ms);
    token.onCancellationRequested(() => {
      clearTimeout(handle);
      reject(new vscode.CancellationError());
    });
  });
}

class CeliadorInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly auth: Auth) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!setting('inlineCompletions.enabled', false)) {return undefined;}
    if (!(await this.auth.isSignedIn())) {return undefined;}

    // Debounce: inline completions fire on nearly every keystroke. A short wait
    // (cancelled when the user keeps typing) keeps request volume sane.
    try {
      await delay(setting('inlineCompletions.debounceMs', 300), token);
    } catch {
      return undefined;
    }
    if (token.isCancellationRequested) {return undefined;}

    const offset = document.offsetAt(position);
    const full = document.getText();
    const prefix = full.slice(Math.max(0, offset - MAX_PREFIX), offset);
    const suffix = full.slice(offset, offset + MAX_SUFFIX);
    if (!prefix.trim() && !suffix.trim()) {return undefined;}

    const completion = await this.fetchCompletion(prefix, suffix, document.languageId, token);
    if (!completion || token.isCancellationRequested) {return undefined;}

    return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
  }

  private async fetchCompletion(
    prefix: string,
    suffix: string,
    language: string,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
      const accessToken = await this.auth.getAccessToken();
      const res = await fetch(`${resolveDaemonUrl()}/api/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prefix, suffix, language }),
        signal: controller.signal,
      });
      if (!res.ok) {return undefined;} // 429/502 etc. — silently skip this suggestion
      const data = (await res.json()) as { completion?: string };
      const text = data.completion ?? '';
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined; // offline, aborted, or signed out — no suggestion
    } finally {
      sub.dispose();
    }
  }
}

/** Register the inline-completion provider for all files. */
export function registerInlineCompletions(auth: Auth): vscode.Disposable {
  return vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    new CeliadorInlineCompletionProvider(auth)
  );
}
