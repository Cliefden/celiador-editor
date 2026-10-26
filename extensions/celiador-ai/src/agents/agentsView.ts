/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { Auth } from '../auth';
import { githubApi, githubToken, machineName, workspaceGitHubRepos, type WorkspaceGitHubRepo } from '../gitReview';
import { bucketTasks, slotsLabel, taskSubtitle, type Task } from './model';
import { RunPanel, type AgentsContext } from './runPanel';
import { TaskFeed, TasksClient } from './tasksClient';
import { nonce, page } from './webview';

// The editor's Agents view (activity bar → "Agents"): the daemon's task queue
// grouped the way the phone shows it — Needs you / Ready to merge / Running /
// Merged today — with "+ Run an issue…" to queue a GitHub issue of an open
// repo, and a run panel per task in the editor area (diff, transcript, merge,
// send back). Live over /api/tasks/stream; dormant while signed out.

/** Sidebar webview → extension. */
type SidebarMessage =
  | { type: 'ready' }
  | { type: 'open'; taskId: string }
  | { type: 'runIssue' }
  | { type: 'signIn' };

/** Extension → sidebar webview. */
interface SidebarState {
  type: 'state';
  status: TaskFeed['status'];
  /** "2 of 3 slots busy" — also drawn in the view itself, since a lone view's description is hidden. */
  slots?: string;
  selected?: string;
  buckets: Array<{ id: string; label: string; tasks: Array<{ id: string; title: string; subtitle: string }> }>;
}

class AgentsSidebar implements vscode.WebviewViewProvider {
  static readonly viewId = 'celiador.agents';
  private view: vscode.WebviewView | undefined;

  constructor(private readonly ctx: AgentsController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = sidebarHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: SidebarMessage) => {
      switch (msg?.type) {
        case 'ready': this.post(); break;
        case 'open': if (typeof msg.taskId === 'string') {void this.ctx.openRun(msg.taskId);} break;
        case 'runIssue': void vscode.commands.executeCommand('celiador.agents.runIssue'); break;
        case 'signIn': void vscode.commands.executeCommand('celiador.signIn'); break;
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) {this.post();} });
    view.onDidDispose(() => { this.view = undefined; });
  }

  /** Push the current buckets + the slots header. */
  post(): void {
    if (!this.view) {return;}
    const list = this.ctx.feed.list;
    const signedIn = this.ctx.feed.status !== 'signed-out';
    const slots = signedIn && list.concurrency > 0 ? slotsLabel(list) : undefined;
    this.view.description = slots;
    const state: SidebarState = {
      type: 'state',
      status: this.ctx.feed.status,
      slots,
      selected: this.ctx.activeTaskId,
      buckets: bucketTasks(list.tasks).map((b) => ({
        id: b.id,
        label: b.label,
        tasks: b.tasks.map((t) => ({ id: t.id, title: t.title, subtitle: taskSubtitle(t, this.ctx.localMachine) })),
      })),
    };
    void this.view.webview.postMessage(state);
  }
}

/** Owns the feed, the sidebar, the run panels and the Agents commands. */
export class AgentsController implements vscode.Disposable, AgentsContext {
  readonly client: TasksClient;
  readonly feed: TaskFeed;
  localMachine: string | undefined;
  activeTaskId: string | undefined;
  private readonly sidebar: AgentsSidebar;
  private readonly panels = new Map<string, RunPanel>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(auth: Auth, daemonUrl: () => string, readonly extensionUri: vscode.Uri) {
    this.client = new TasksClient(auth, daemonUrl);
    this.feed = new TaskFeed(this.client, auth);
    this.sidebar = new AgentsSidebar(this);
    void machineName().then((m) => { this.localMachine = m; this.sidebar.post(); }, () => undefined);
    this.disposables.push(
      this.feed,
      vscode.window.registerWebviewViewProvider(AgentsSidebar.viewId, this.sidebar),
      this.feed.onDidChange(() => {
        this.sidebar.post();
        for (const panel of this.panels.values()) {panel.update();}
      }),
      vscode.commands.registerCommand('celiador.agents.runIssue', () => this.runIssue()),
      vscode.commands.registerCommand('celiador.agents.refresh', () => this.feed.refresh()),
      vscode.commands.registerCommand('celiador.agents.openRun', async (taskId?: string) => {
        const id = taskId ?? await this.pickTask('Open an agent run');
        if (id) {await this.openRun(id);}
      }),
      vscode.commands.registerCommand('celiador.agents.merge', async (taskId?: string) => this.withPanel(taskId, 'Merge which run?', (p) => p.merge())),
      vscode.commands.registerCommand('celiador.agents.sendBack', async (taskId?: string) => this.withPanel(taskId, 'Send which run back?', (p) => p.sendBack())),
      vscode.commands.registerCommand('celiador.agents.openWorktree', async (taskId?: string) => this.withPanel(taskId, 'Open which run\'s worktree?', (p) => p.openWorktree())),
    );
  }

  task(taskId: string): Task | undefined {
    return this.feed.get(taskId);
  }

  /** Open (or reveal) the run panel of `taskId`. */
  async openRun(taskId: string): Promise<RunPanel | undefined> {
    const task = this.feed.get(taskId);
    if (!task) {
      void vscode.window.showWarningMessage('That agent run is no longer in the queue.');
      return undefined;
    }
    let panel = this.panels.get(taskId);
    if (panel) {
      panel.reveal();
    } else {
      panel = new RunPanel(this, taskId);
      this.panels.set(taskId, panel);
      panel.onDidDispose(() => {
        this.panels.delete(taskId);
        if (this.activeTaskId === taskId) {this.activeTaskId = undefined; this.sidebar.post();}
      });
      panel.onDidFocus(() => { this.activeTaskId = taskId; this.sidebar.post(); });
    }
    this.activeTaskId = taskId;
    this.sidebar.post();
    return panel;
  }

  private async withPanel(taskId: string | undefined, placeHolder: string, run: (panel: RunPanel) => Promise<void>): Promise<void> {
    const id = taskId ?? this.activeTaskId ?? await this.pickTask(placeHolder);
    if (!id) {return;}
    const panel = await this.openRun(id);
    if (panel) {await run(panel);}
  }

  private async pickTask(placeHolder: string): Promise<string | undefined> {
    const items = bucketTasks(this.feed.list.tasks).flatMap((b) => b.tasks.map((t) => ({ label: t.title, description: b.label, detail: taskSubtitle(t, this.localMachine), id: t.id })));
    if (!items.length) {
      void vscode.window.showInformationMessage('No agent runs yet.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.id;
  }

  // --- "+ Run an issue…" -------------------------------------------------------

  /** Queue an open GitHub issue of a repo in this window as an agent task (or a task you describe). */
  private async runIssue(): Promise<void> {
    if (!(await this.client.signedIn())) {
      const pick = await vscode.window.showWarningMessage('Sign in to Celiador to run agents.', 'Sign In');
      if (pick) {void vscode.commands.executeCommand('celiador.signIn');}
      return;
    }
    const repos = await workspaceGitHubRepos();
    if (!repos.length) {
      void vscode.window.showWarningMessage('Open a folder whose git remote is on GitHub to run its issues.');
      return;
    }
    type Item = vscode.QuickPickItem & { action?: 'manual' | 'github-sign-in'; repo?: WorkspaceGitHubRepo; issue?: { number: number; title: string; url: string; body: string } };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Run an Issue';
    qp.placeholder = 'Pick an open issue for an agent to work on in its own worktree';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.busy = true;
    const manual: Item = { label: '$(edit) Describe a task instead…', alwaysShow: true, action: 'manual' };
    const noIssues: Item = { label: 'No open issues in this window\'s GitHub repos.', alwaysShow: true };
    qp.items = [manual];
    qp.show();

    const load = async (interactive: boolean) => {
      qp.busy = true;
      const token = await githubToken(interactive);
      if (!token) {
        qp.items = [manual, { label: '$(github) Sign in to GitHub to list issues…', alwaysShow: true, action: 'github-sign-in' }];
        qp.busy = false;
        return;
      }
      const api = githubApi(token);
      const lists = await Promise.all(repos.map(async (repo) => {
        const res = await api('GET', `/repos/${repo.owner}/${repo.repo}/issues?state=open&per_page=50&sort=updated`).catch(() => undefined);
        const issues = Array.isArray(res?.json) ? res!.json.filter((i: any) => !i.pull_request && typeof i.number === 'number') : [];
        return issues.map((i: any): Item => ({
          label: `#${i.number} ${i.title}`,
          description: repos.length > 1 ? `${repo.owner}/${repo.repo}` : undefined,
          detail: Array.isArray(i.labels) && i.labels.length ? i.labels.map((l: any) => l?.name).filter(Boolean).join(' · ') : undefined,
          repo,
          issue: { number: i.number, title: String(i.title ?? ''), url: String(i.html_url ?? ''), body: typeof i.body === 'string' ? i.body : '' },
        }));
      }));
      const issues = lists.flat();
      qp.items = [manual, ...(issues.length ? issues : [noIssues])];
      qp.busy = false;
    };
    void load(false);

    const picked = await new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => {
        const item = qp.selectedItems[0];
        if (item?.action === 'github-sign-in') {
          void load(true);
          return;
        }
        if (!item?.action && !item?.issue) {return;}
        resolve(item);
        qp.hide();
      });
      qp.onDidHide(() => resolve(undefined));
    });
    qp.dispose();
    if (!picked) {return;}

    try {
      if (picked.issue && picked.repo) {
        const { task, deduped } = await this.client.create({
          remoteUrl: `https://github.com/${picked.repo.owner}/${picked.repo.repo}`,
          title: picked.issue.title,
          details: picked.issue.body,
          issue: { number: picked.issue.number, title: picked.issue.title, url: picked.issue.url },
        });
        if (task) {this.feed.upsert(task);}
        if (deduped && task) {
          // That issue already has an open run: show it rather than queue a second one.
          void vscode.window.showInformationMessage(`Issue #${picked.issue.number} already has an agent run.`);
          await this.openRun(task.id);
          return;
        }
        void vscode.window.showInformationMessage(`Queued issue #${picked.issue.number} for an agent.`);
        return;
      }
      const repo = repos.length === 1 ? repos[0] : (await vscode.window.showQuickPick(repos.map((r) => ({ label: `${r.owner}/${r.repo}`, detail: r.root.fsPath, r })), { placeHolder: 'Which repository?' }))?.r;
      if (!repo) {return;}
      const title = (await vscode.window.showInputBox({ title: 'Run a Task', prompt: `What should the agent do in ${repo.owner}/${repo.repo}?`, placeHolder: 'e.g. Add a cancel button to the session view', ignoreFocusOut: true }))?.trim();
      if (!title) {return;}
      const { task } = await this.client.create({ remoteUrl: `https://github.com/${repo.owner}/${repo.repo}`, title });
      if (task) {this.feed.upsert(task);}
      void vscode.window.showInformationMessage('Queued the task for an agent.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't queue the task: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) {panel.dispose();}
    for (const d of this.disposables) {d.dispose();}
  }
}

/** Register the Agents view, its run panels and commands. */
export function registerAgentsView(auth: Auth, daemonUrl: () => string, extensionUri: vscode.Uri): vscode.Disposable {
  return new AgentsController(auth, daemonUrl, extensionUri);
}

function sidebarHtml(cspSource: string): string {
  const n = nonce();
  return page({
    nonce: n,
    cspSource,
    title: 'Agents',
    css: `
  body { padding: 4px 8px 12px; }
  .run-issue { width: 100%; min-height: 30px; margin: 4px 0 12px; border-radius: 4px; border: 1px dashed var(--vscode-widget-border, var(--vscode-contrastBorder, rgba(128,128,128,.45))); background: transparent; color: var(--vscode-foreground); }
  .run-issue:hover { background: var(--vscode-list-hoverBackground); }
  .group { margin-bottom: 12px; }
  .group-label { padding: 0 6px 4px; font-size: 11px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .group-label.needs-you { color: var(--vscode-editorWarning-foreground); }
  .group-label.ready { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .group-label.failed-today { color: var(--vscode-errorForeground); }
  .row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 6px 8px; border: 0; border-radius: 4px; background: transparent; color: inherit; text-align: left; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
  .row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .sub { font-family: var(--mono); font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compact .row { padding: 3px 8px; color: var(--vscode-descriptionForeground); }
  .notice { padding: 8px 6px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .status { padding: 0 6px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
`,
    body: '<div id="root"></div>',
    script: `
  const root = document.getElementById('root');
  function render(state) {
    root.replaceChildren();
    if (state.status === 'signed-out') {
      root.append(el('div', { class: 'notice' }, 'Sign in to Celiador to see your agent runs and queue GitHub issues for them.'),
        el('button', { class: 'btn primary', onclick: () => vscode.postMessage({ type: 'signIn' }) }, 'Sign In'));
      return;
    }
    if (state.slots) root.append(el('div', { class: 'status' }, state.slots));
    root.append(el('button', { class: 'run-issue', onclick: () => vscode.postMessage({ type: 'runIssue' }) }, '+ Run an issue…'));
    if (state.status === 'offline') root.append(el('div', { class: 'status' }, 'Reconnecting to the daemon…'));
    if (!state.buckets.length) {
      root.append(el('div', { class: 'notice' }, state.status === 'connecting' ? 'Loading…' : 'No agent runs yet. Run an issue and an agent picks it up in its own worktree.'));
      return;
    }
    for (const bucket of state.buckets) {
      const compact = bucket.id === 'merged-today';
      root.append(el('div', { class: 'group' + (compact ? ' compact' : ''), role: 'group', 'aria-label': bucket.label },
        el('div', { class: 'group-label ' + bucket.id }, bucket.label + ' · ' + bucket.tasks.length),
        bucket.tasks.map(t => el('button', {
          class: 'row' + (t.id === state.selected ? ' selected' : ''),
          title: t.title + '\\n' + t.subtitle,
          'aria-current': t.id === state.selected ? 'true' : undefined,
          onclick: () => vscode.postMessage({ type: 'open', taskId: t.id }),
        }, el('span', { class: 'title' }, t.title), compact ? null : el('span', { class: 'sub' }, t.subtitle)))));
    }
  }
  window.addEventListener('message', e => { if (e.data && e.data.type === 'state') render(e.data); });
  vscode.postMessage({ type: 'ready' });
`,
  });
}
