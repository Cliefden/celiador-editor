/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

interface ChangedFile {
  readonly status: string; // two-letter porcelain code, e.g. " M", "A ", "??"
  readonly path: string;
}

/**
 * A SourceTree-style "Changes" view: the workspace's git working-tree changes
 * (which, for a local agent run, are the agent's edits). Click a file to open its
 * diff. Deliberately a lightweight review surface over the repo — the daemon/agent
 * side already streams per-run diffs to the companion.
 */
export class CeliadorChangesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'celiador.changes';
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'refresh') {
        await this.refresh();
      } else if (msg?.type === 'open' && typeof msg.path === 'string') {
        await this.openDiff(msg.path);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {void this.refresh();}
    });
    void this.refresh();
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Re-read git status and push the file list to the webview. */
  private async refresh(): Promise<void> {
    if (!this.view) {return;}
    const root = this.workspaceRoot();
    if (!root) {
      this.view.webview.postMessage({ type: 'files', files: [], error: 'No folder open.' });
      return;
    }
    try {
      const { stdout } = await run('git', ['status', '--porcelain=v1'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
      const files = parseStatus(stdout);
      this.view.webview.postMessage({ type: 'files', files });
    } catch {
      this.view.webview.postMessage({ type: 'files', files: [], error: 'Not a git repository (or git unavailable).' });
    }
  }

  /** Open the file's working-tree change in a diff editor (falls back to opening the file). */
  private async openDiff(rel: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {return;}
    const uri = vscode.Uri.file(path.join(root, rel));
    try {
      await vscode.commands.executeCommand('git.openChange', uri);
    } catch {
      await vscode.window.showTextDocument(uri).then(undefined, () => undefined);
    }
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground); padding: 6px; margin: 0; }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 3px 8px; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 8px; padding: 3px 4px; cursor: pointer; border-radius: 3px; align-items: center; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  .code { width: 18px; text-align: center; font-weight: 600; font-family: var(--vscode-editor-font-family); }
  .m { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .a { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .d { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .u { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px 4px; }
</style>
</head>
<body>
  <div class="bar"><strong>Changes</strong><button id="refresh">Refresh</button></div>
  <ul id="list"></ul>
  <div id="empty" class="empty" style="display:none"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');
    const empty = document.getElementById('empty');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    function cls(code) {
      const c = code.trim();
      if (c === '??') return 'u';
      if (c.includes('A')) return 'a';
      if (c.includes('D')) return 'd';
      return 'm';
    }
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type !== 'files') return;
      list.innerHTML = '';
      if (msg.error || !msg.files.length) {
        empty.style.display = 'block';
        empty.textContent = msg.error || 'No changes.';
        return;
      }
      empty.style.display = 'none';
      for (const f of msg.files) {
        const li = document.createElement('li');
        li.onclick = () => vscode.postMessage({ type: 'open', path: f.path });
        const code = document.createElement('span');
        code.className = 'code ' + cls(f.status);
        code.textContent = (f.status.trim() || '?').slice(0, 1);
        const p = document.createElement('span');
        p.className = 'path';
        p.textContent = f.path;
        li.appendChild(code); li.appendChild(p);
        list.appendChild(li);
      }
    });
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}

/** Parse `git status --porcelain=v1` into changed files (new path for renames). */
function parseStatus(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length < 4) {continue;}
    const status = line.slice(0, 2);
    let p = line.slice(3);
    const arrow = p.indexOf(' -> '); // rename: "old -> new"
    if (arrow !== -1) {p = p.slice(arrow + 4);}
    files.push({ status, path: p });
  }
  return files;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {text += chars.charAt(Math.floor(Math.random() * chars.length));}
  return text;
}
