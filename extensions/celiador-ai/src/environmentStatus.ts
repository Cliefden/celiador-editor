/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { describeEnvironment, type DaemonHealth, type EnvironmentDescription } from './environment';
import { getRestrictedSetting } from './config';
import { productIdentity, resolveDaemonUrl } from './productConfig';

// The environment status item: which daemon this window works against, from
// the first status bar slot. A Test or Dev build is named as such in the title
// bar, but the `celiador.daemonUrl` setting can repoint any build (and only
// the extension — the native agent host keeps the build's URL), so the item
// shows the environment the daemon itself reports and goes red when the two
// halves of the client disagree. Non-prod is always amber: nobody should
// discover from an empty queue that they were on test all along.

const COMMAND = 'celiador.showEnvironment';

async function probeHealth(url: string): Promise<{ health?: DaemonHealth; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${url}/api/health`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {return { error: `HTTP ${res.status}` };}
      const body = (await res.json()) as DaemonHealth;
      return { health: { env: body.env, version: body.version, commit: body.commit } };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    return { error: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? String(err)) };
  }
}

/** Register the status item, its command and the refresh triggers. */
export function registerEnvironmentStatus(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem('celiador.environment', vscode.StatusBarAlignment.Left, 100);
  item.name = 'Celiador Environment';
  item.command = COMMAND;
  context.subscriptions.push(item);

  let current: EnvironmentDescription | undefined;
  let refreshing: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (refreshing) {return refreshing;}
    refreshing = (async () => {
      const identity = productIdentity();
      const extensionDaemonUrl = resolveDaemonUrl();
      const nativeDaemonUrl = identity.daemonUrl;
      const overridden = Boolean(getRestrictedSetting<string>('daemonUrl', ''));

      // Show the host-name guess at once, then the daemon's own answer.
      const paint = (description: EnvironmentDescription) => {
        current = description;
        item.text = `$(server-environment) ${description.label}`;
        const tooltip = new vscode.MarkdownString(description.lines.join('\n\n'));
        tooltip.isTrusted = false;
        item.tooltip = tooltip;
        item.backgroundColor =
          description.severity === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : description.severity === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground')
              : undefined;
        item.show();
      };

      paint(describeEnvironment({ build: identity, extensionDaemonUrl, nativeDaemonUrl, overridden }));
      const probe = await probeHealth(extensionDaemonUrl);
      paint(describeEnvironment({ build: identity, extensionDaemonUrl, nativeDaemonUrl, overridden, health: probe.health, healthError: probe.error }));
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, async () => {
      await refresh();
      if (!current) {return;}
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(copy) Copy environment info', id: 'copy', detail: current.summary },
          { label: '$(link-external) Open daemon in browser', id: 'open', detail: resolveDaemonUrl() },
          { label: '$(settings-gear) Change daemon URL (celiador.daemonUrl)', id: 'settings', detail: 'User setting; the native agent host keeps the build\'s URL' },
          { label: '$(refresh) Refresh', id: 'refresh' },
        ],
        { placeHolder: current.lines[0].replace(/\*\*/g, ''), matchOnDetail: true }
      );
      if (!pick) {return;}
      switch (pick.id) {
        case 'copy':
          await vscode.env.clipboard.writeText(current.summary);
          void vscode.window.showInformationMessage('Celiador environment info copied.');
          break;
        case 'open':
          await vscode.env.openExternal(vscode.Uri.parse(resolveDaemonUrl()));
          break;
        case 'settings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'celiador.daemonUrl');
          break;
        case 'refresh':
          break;
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('celiador.daemonUrl')) {void refresh();}
    })
  );

  // Pick up a daemon that comes back (or changes env behind the same host) now and then.
  const timer = setInterval(() => void refresh(), 10 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  void refresh();
}
