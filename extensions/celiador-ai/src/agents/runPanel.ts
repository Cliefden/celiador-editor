/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { defaultBranch, githubApi, githubToken, gitUriAt, parseGitHubRemote, runGit } from '../gitReview';
import { buildTranscript, issueQuote, parseNumstat, parseUnifiedDiff, prNumber, runMeta, type DiffLine, type FileStat, type SessionEvent, type Task, type TranscriptItem } from './model';
import { DaemonError, type TaskFeed, type TasksClient } from './tasksClient';
import { nonce, page } from './webview';

// One agent run in the editor area: header (issue · worktree · where it ran),
// Open worktree / Send back… / Merge PR #n, per-file tabs with +/− counts and
// the selected file's diff, and the run's transcript with a follow-up box. The
// diff comes from the run's local worktree (via the workbench's task-run record)
// or, for a run on another machine / the cloud, from the pull request on GitHub.

/** What the panel needs from the Agents controller. */
export interface AgentsContext {
  readonly client: TasksClient;
  readonly feed: TaskFeed;
  readonly localMachine: string | undefined;
  readonly extensionUri: vscode.Uri;
  task(taskId: string): Task | undefined;
}

/** `celiador.taskRunInfo` (workbench core): where this window ran a task. */
interface TaskRunInfo {
  taskId: string;
  branch: string;
  repoRoot: string;
  worktree?: string;
  sessionResource: string;
  finished: boolean;
  prUrl?: string;
}

/** Webview → extension. */
type PanelMessage =
  | { type: 'ready' }
  | { type: 'openWorktree' }
  | { type: 'sendBack' }
  | { type: 'merge' }
  | { type: 'selectFile'; path: string }
  | { type: 'openDiff' }
  | { type: 'followup'; text: string }
  | { type: 'openChat' }
  | { type: 'openLink'; which: 'pr' | 'issue' }
  | { type: 'approve'; decision: 'approve' | 'reject' }
  | { type: 'answer' };

/** Extension → webview. */
type PanelUpdate =
  | {
    type: 'header';
    meta: string;
    title: string;
    stateLabel: string;
    prNumber?: number;
    canMerge: boolean;
    canSendBack: boolean;
    canOpenWorktree: boolean;
    awaiting?: { kind: 'permission' | 'question'; text: string; preview?: string };
    error?: string;
    activity?: string;
    note?: string;
  }
  | { type: 'files'; files: FileStat[]; selected?: string; source?: 'local' | 'github'; message?: string; canOpenDiff: boolean }
  | { type: 'diff'; path: string; lines: DiffLine[]; truncated: boolean; message?: string }
  | { type: 'transcript'; quote: string; issueNumber?: number; items: TranscriptItem[]; pr?: { number: number }; live: boolean; message?: string };

const MAX_DIFF_LINES = 4_000;

const STATE_LABELS: Record<Task['state'], string> = {
  queued: 'Queued',
  dispatched: 'Starting',
  running: 'Running',
  'pr-open': 'Ready to merge',
  merged: 'Merged',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export class RunPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  private readonly focusEmitter = new vscode.EventEmitter<void>();
  readonly onDidFocus = this.focusEmitter.event;
  private disposed = false;

  private info: TaskRunInfo | undefined;
  /** Local diffs are against the merge base of the run's branch and its base branch. */
  private mergeBase: string | undefined;
  private files: FileStat[] = [];
  private filesSource: 'local' | 'github' | undefined;
  /** GitHub fallback: per-file patches from the PR files API. */
  private githubPatches = new Map<string, string>();
  private selected: string | undefined;
  private filesKey: string | undefined;

  private events: SessionEvent[] = [];
  private streamAbort: AbortController | undefined;
  private streamSessionId: string | undefined;
  private live = false;
  private transcriptTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private note: string | undefined;

  constructor(private readonly ctx: AgentsContext, readonly taskId: string) {
    const task = ctx.task(taskId);
    this.panel = vscode.window.createWebviewPanel('celiador.agentRun', task?.title ?? 'Agent run', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'agents.svg');
    this.panel.webview.html = panelHtml(this.panel.webview.cspSource);
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => void this.onMessage(msg));
    this.panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) {this.focusEmitter.fire();} });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.streamAbort?.abort();
      if (this.transcriptTimer) {clearTimeout(this.transcriptTimer);}
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
      this.focusEmitter.dispose();
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }

  private get task(): Task | undefined {
    return this.ctx.task(this.taskId);
  }

  private post(msg: PanelUpdate): void {
    if (!this.disposed) {void this.panel.webview.postMessage(msg);}
  }

  /** The feed changed: refresh the header, follow a new session, reload files when the run moved on. */
  update(): void {
    const task = this.task;
    if (!task || this.disposed) {return;}
    this.panel.title = task.title;
    this.postHeader();
    if (task.sessionId && task.sessionId !== this.streamSessionId) {this.followSession(task.sessionId);}
    const key = `${task.state}|${task.pr?.number ?? ''}|${task.pr?.additions ?? ''}|${task.pr?.deletions ?? ''}|${task.prUrl ?? ''}`;
    if (key !== this.filesKey) {
      this.filesKey = key;
      void this.loadFiles();
    }
    this.scheduleTranscript();
  }

  private async onMessage(msg: PanelMessage): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.filesKey = undefined;
        this.update();
        return;
      case 'openWorktree': return this.openWorktree();
      case 'sendBack': return this.sendBack();
      case 'merge': return this.merge();
      case 'selectFile':
        if (typeof msg.path === 'string') {
          this.selected = msg.path;
          this.postFiles();
          await this.loadDiff(msg.path);
        }
        return;
      case 'openDiff': return this.openNativeDiff();
      case 'followup':
        if (typeof msg.text === 'string' && msg.text.trim()) {await this.followup(msg.text.trim());}
        return;
      case 'openChat': return this.openChat();
      case 'openLink': {
        const task = this.task;
        const url = msg.which === 'pr' ? task?.pr?.url ?? task?.prUrl : task?.issue?.url;
        if (url) {await vscode.env.openExternal(vscode.Uri.parse(url));}
        return;
      }
      case 'approve': return this.decide(msg.decision === 'reject' ? 'reject' : 'approve');
      case 'answer': return this.answer();
    }
  }

  // --- header ------------------------------------------------------------------

  private postHeader(): void {
    const task = this.task;
    if (!task) {return;}
    const n = prNumber(task);
    const terminal = task.state === 'merged' || task.state === 'cancelled';
    this.post({
      type: 'header',
      meta: runMeta(task, this.ctx.localMachine),
      title: task.title,
      stateLabel: STATE_LABELS[task.state] ?? task.state,
      prNumber: n,
      canMerge: !this.busy && task.state === 'pr-open' && n !== undefined && task.pr?.mergeable !== false,
      canSendBack: !this.busy && !terminal && (!!task.sessionId || !!this.info),
      canOpenWorktree: !!this.info?.worktree,
      awaiting: task.awaiting ? { kind: task.awaiting.kind, text: task.awaiting.text, preview: task.awaiting.preview } : undefined,
      error: task.state === 'failed' ? task.error : undefined,
      activity: task.state === 'running' ? task.activity : undefined,
      note: task.pr?.mergeable === false ? 'GitHub reports merge conflicts on this pull request.' : this.note,
    });
  }

  private setNote(note: string | undefined): void {
    this.note = note;
    this.postHeader();
  }

  async openWorktree(): Promise<void> {
    const info = this.info ?? await this.loadInfo();
    if (!info?.worktree) {
      void vscode.window.showInformationMessage('This run\'s worktree isn\'t on this machine (it ran elsewhere, or was removed).');
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(info.worktree), { forceNewWindow: true });
  }

  async sendBack(): Promise<void> {
    const task = this.task;
    if (!task) {return;}
    const text = (await vscode.window.showInputBox({
      title: `Send Back: ${task.title}`,
      prompt: 'What should the agent change? It continues in the same worktree and pushes to the same pull request.',
      placeHolder: 'e.g. Also disable the button while cancelling',
      ignoreFocusOut: true,
    }))?.trim();
    if (text) {await this.followup(text);}
  }

  /** A follow-up turn: the daemon's `/followup`, else the relay session directly, else the local chat. */
  private async followup(text: string): Promise<void> {
    const task = this.task;
    if (!task) {return;}
    try {
      await this.ctx.client.followup(task.id, text);
      this.setNote('Sent back to the agent.');
      return;
    } catch (err) {
      // Older daemon (no /followup): talk to the relay session directly.
      if (err instanceof DaemonError && (err.status === 404 || err.status === 405) && task.sessionId) {
        try {
          await this.ctx.client.sessionMessage(task.sessionId, text);
          this.setNote('Sent back to the agent.');
          return;
        } catch {
          /* fall through to the local chat */
        }
      }
    }
    if (await vscode.commands.executeCommand<boolean>('celiador.openTaskSession', task.id).then((ok) => ok, () => false)) {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('The daemon couldn\'t reach the run, so its chat is open here: your follow-up is on the clipboard to paste.');
      return;
    }
    void vscode.window.showErrorMessage('Couldn\'t send the follow-up: the run\'s editor is offline and its chat isn\'t in this window.');
  }

  async merge(): Promise<void> {
    const task = this.task;
    const n = task && prNumber(task);
    if (!task || n === undefined) {return;}
    const pick = await vscode.window.showWarningMessage(
      `Merge pull request #${n}?`,
      { modal: true, detail: `${task.title}\n\nBranch ${task.branch} in ${task.repo.owner}/${task.repo.name}.` },
      'Merge', 'Squash and Merge',
    );
    if (!pick) {return;}
    const method = pick === 'Squash and Merge' ? 'squash' : 'merge';
    this.busy = true;
    this.setNote(`Merging #${n}…`);
    try {
      try {
        await this.ctx.client.merge(task.id, method);
      } catch (err) {
        // The daemon couldn't reach the pull request (older daemon without the route, or no App and
        // the run's editor offline from it): merge with this editor's GitHub sign-in, by branch. Any
        // other refusal (not mergeable, wrong state) is the pull request's answer — show it.
        const unreachable = err instanceof DaemonError
          && (err.status === 404 || err.status === 405 || (err.status === 409 && /editor offline/i.test(err.message)));
        if (!unreachable) {throw err;}
        const info = this.info ?? await this.loadInfo();
        const result = await vscode.commands.executeCommand<{ ok: boolean; error?: string }>('celiador.relayGit', { kind: 'git.merge', head: task.branch, root: info?.worktree ?? info?.repoRoot, method });
        if (!result?.ok) {throw new Error(result?.error ?? (err instanceof Error ? err.message : String(err)));}
        await this.ctx.client.reportMerged(task.id).catch(() => undefined);
      }
      this.note = undefined;
      void vscode.window.showInformationMessage(`Merged #${n}: ${task.title}`);
      await this.ctx.feed.refresh();
    } catch (err) {
      this.note = undefined;
      void vscode.window.showErrorMessage(`Couldn't merge #${n}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
      this.postHeader();
    }
  }

  private async decide(decision: 'approve' | 'reject'): Promise<void> {
    const task = this.task;
    if (!task?.awaiting || !task.sessionId) {return;}
    try {
      await this.ctx.client.decide(task.sessionId, task.awaiting.requestId, decision);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't ${decision === 'approve' ? 'approve' : 'deny'}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async answer(): Promise<void> {
    const task = this.task;
    const awaiting = task?.awaiting;
    if (!task?.sessionId || !awaiting) {return;}
    const text = awaiting.choices?.length
      ? (await vscode.window.showQuickPick(awaiting.choices, { placeHolder: awaiting.text }))
      : (await vscode.window.showInputBox({ prompt: awaiting.text, ignoreFocusOut: true }))?.trim();
    if (!text) {return;}
    try {
      await this.ctx.client.answer(task.sessionId, awaiting.requestId, text);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async openChat(): Promise<void> {
    const ok = await vscode.commands.executeCommand<boolean>('celiador.openTaskSession', this.taskId).then((r) => r, () => false);
    if (!ok) {void vscode.window.showInformationMessage('This run\'s chat isn\'t in this window: it ran in another window, on another machine, or in the cloud.');}
  }

  // --- files + diff --------------------------------------------------------------

  private async loadInfo(): Promise<TaskRunInfo | undefined> {
    this.info = await vscode.commands.executeCommand<TaskRunInfo | undefined>('celiador.taskRunInfo', this.taskId).then((r) => r, () => undefined);
    if (this.info?.worktree) {
      const exists = await vscode.workspace.fs.stat(vscode.Uri.file(this.info.worktree)).then(() => true, () => false);
      if (!exists) {this.info = { ...this.info, worktree: undefined };}
    }
    return this.info;
  }

  /** The merge base of HEAD and the run's base branch (origin's first), in the worktree. */
  private async findMergeBase(worktree: string, repoRoot: string): Promise<string | undefined> {
    const base = (await defaultBranch(repoRoot)) ?? 'main';
    for (const ref of [`origin/${base}`, base]) {
      try {
        const sha = (await runGit(worktree, ['merge-base', ref, 'HEAD'])).trim();
        if (sha) {return sha;}
      } catch {
        /* try the next candidate */
      }
    }
    return undefined;
  }

  private async loadFiles(): Promise<void> {
    const task = this.task;
    if (!task) {return;}
    const info = await this.loadInfo();
    this.postHeader();
    let message: string | undefined;
    this.files = [];
    this.filesSource = undefined;
    this.githubPatches.clear();
    if (info?.worktree) {
      const mergeBase = await this.findMergeBase(info.worktree, info.repoRoot);
      if (mergeBase) {
        try {
          // Against the working tree: committed and not-yet-committed changes alike.
          this.files = parseNumstat(await runGit(info.worktree, ['diff', '--numstat', '-M', mergeBase]));
          this.mergeBase = mergeBase;
          this.filesSource = 'local';
        } catch (err) {
          message = `git diff failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        message = 'Couldn\'t find the branch the run started from.';
      }
    }
    if (!this.filesSource) {
      const fromGitHub = await this.loadGitHubFiles(task);
      if (fromGitHub) {
        message = undefined;
      } else if (!message) {
        message = task.state === 'queued' || task.state === 'dispatched' ? 'No changes yet.'
          : info ? 'No changes yet.' : 'The diff shows once the run opens its pull request (it ran on another machine).';
      }
    }
    if (!this.files.length && !message) {message = 'No changes yet.';}
    if (!this.selected || !this.files.some((f) => f.path === this.selected)) {this.selected = this.files[0]?.path;}
    this.postFiles(message);
    if (this.selected) {await this.loadDiff(this.selected);}
    else {this.post({ type: 'diff', path: '', lines: [], truncated: false });}
  }

  /** The PR's files (with patches) from GitHub, for a run whose worktree isn't here. */
  private async loadGitHubFiles(task: Task): Promise<boolean> {
    const n = prNumber(task);
    const target = parseGitHubRemote(task.repo.url);
    if (n === undefined || !target) {return false;}
    const token = await githubToken();
    if (!token) {return false;}
    const res = await githubApi(token)('GET', `/repos/${target.owner}/${target.repo}/pulls/${n}/files?per_page=100`).catch(() => undefined);
    if (!res || res.status !== 200 || !Array.isArray(res.json)) {return false;}
    this.files = res.json.map((f: any): FileStat => ({ path: String(f.filename), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0, binary: typeof f.patch !== 'string' }));
    for (const f of res.json) {
      if (typeof f.patch === 'string') {this.githubPatches.set(String(f.filename), f.patch);}
    }
    this.filesSource = 'github';
    return true;
  }

  private postFiles(message?: string): void {
    this.post({ type: 'files', files: this.files, selected: this.selected, source: this.filesSource, message, canOpenDiff: !!this.selected });
  }

  private async loadDiff(path: string): Promise<void> {
    let patch: string | undefined;
    let message: string | undefined;
    const file = this.files.find((f) => f.path === path);
    if (file?.binary) {
      message = 'Binary file — no text diff.';
    } else if (this.filesSource === 'local' && this.info?.worktree && this.mergeBase) {
      try {
        patch = await runGit(this.info.worktree, ['diff', '-M', this.mergeBase, '--', path]);
      } catch (err) {
        message = `git diff failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (this.filesSource === 'github') {
      patch = this.githubPatches.get(path);
      if (patch === undefined) {message = 'GitHub doesn\'t show a diff for this file (too large).';}
    }
    const lines = patch ? parseUnifiedDiff(patch) : [];
    if (this.selected !== path) {return;} // the user moved on
    this.post({ type: 'diff', path, lines: lines.slice(0, MAX_DIFF_LINES), truncated: lines.length > MAX_DIFF_LINES, message: message ?? (patch !== undefined && !lines.length ? 'No textual changes (mode or rename only).' : undefined) });
  }

  /** The selected file in the native diff editor (local), or the PR's files page on GitHub. */
  private async openNativeDiff(): Promise<void> {
    const task = this.task;
    const path = this.selected;
    if (!task || !path) {return;}
    if (this.filesSource === 'local' && this.info?.worktree && this.mergeBase) {
      const right = vscode.Uri.joinPath(vscode.Uri.file(this.info.worktree), ...path.split('/'));
      const left = await gitUriAt(right, this.mergeBase);
      if (left) {
        await vscode.commands.executeCommand('vscode.diff', left, right, `${path} (${task.branch})`);
        return;
      }
      await vscode.window.showTextDocument(right).then(undefined, () => undefined);
      return;
    }
    const url = task.pr?.url ?? task.prUrl;
    if (url) {await vscode.env.openExternal(vscode.Uri.parse(`${url.replace(/\/+$/, '')}/files`));}
  }

  // --- transcript ------------------------------------------------------------------

  /** Stream the linked relay session's events (replay + live), reconnecting with backoff. */
  private followSession(sessionId: string): void {
    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;
    this.streamSessionId = sessionId;
    this.events = [];
    void (async () => {
      let backoff = 1_000;
      while (!abort.signal.aborted && !this.disposed) {
        try {
          // Each connection replays the log from the start, so begin afresh.
          let first = true;
          await this.ctx.client.sessionEvents(sessionId, (ev) => {
            if (first) {this.events = []; first = false;}
            this.events.push(ev);
            this.live = true;
            backoff = 1_000;
            this.scheduleTranscript();
          }, abort.signal);
        } catch (err) {
          if (err instanceof DaemonError && err.status === 404) {break;} // the session is gone
        }
        this.live = false;
        this.scheduleTranscript();
        if (abort.signal.aborted || this.disposed) {break;}
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();
  }

  private scheduleTranscript(): void {
    if (this.transcriptTimer) {return;}
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined;
      this.postTranscript();
    }, 120);
  }

  private postTranscript(): void {
    const task = this.task;
    if (!task) {return;}
    const n = prNumber(task);
    this.post({
      type: 'transcript',
      quote: issueQuote(task),
      issueNumber: task.issue?.number,
      items: buildTranscript(this.events),
      pr: n !== undefined ? { number: n } : undefined,
      live: this.live,
      message: task.sessionId ? undefined : task.state === 'queued' ? 'Waiting for a free slot.' : 'The transcript shows once the run starts.',
    });
  }
}

function panelHtml(cspSource: string): string {
  const n = nonce();
  return page({
    nonce: n,
    cspSource,
    title: 'Agent run',
    css: `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; overflow: hidden; background: var(--vscode-editor-background); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .head { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 320px; }
  .meta { font-family: var(--mono); font-size: 12px; color: var(--vscode-descriptionForeground); }
  h1 { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; }
  .state { font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .banner { margin: 0; padding: 8px 20px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .banner.warn { background: var(--vscode-inputValidation-warningBackground); }
  .banner.err { background: var(--vscode-inputValidation-errorBackground); }
  .banner .text { flex: 1; min-width: 200px; }
  .banner pre { margin: 4px 0 0; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; }
  .main { flex: 1; display: flex; min-height: 0; }
  .diffpane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .tabbar { display: flex; align-items: stretch; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
  .tabs { flex: 1; display: flex; gap: 2px; padding: 0 12px; overflow-x: auto; }
  .tab { padding: 8px 10px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); }
  .tab .add, .tab .del { font-family: var(--mono); font-size: 12px; margin-left: 4px; }
  .tabtools { display: flex; align-items: center; padding: 0 12px; }
  .diff { flex: 1; overflow: auto; font-family: var(--mono); font-size: var(--vscode-editor-font-size, 13px); line-height: 1.6; padding: 8px 0; }
  .line { display: flex; white-space: pre; min-width: max-content; }
  .ln { width: 52px; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
  .sign { width: 16px; flex-shrink: 0; color: var(--vscode-descriptionForeground); user-select: none; }
  .line.add { background: var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground)); }
  .line.del { background: var(--vscode-diffEditor-removedLineBackground, var(--vscode-diffEditor-removedTextBackground)); }
  .line.hunk { color: var(--vscode-descriptionForeground); margin: 6px 0 2px; }
  .empty { padding: 16px 20px; color: var(--vscode-descriptionForeground); }
  aside { width: 300px; flex-shrink: 0; border-left: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; min-height: 0; }
  .aside-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; }
  h2 { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .8px; text-transform: uppercase; color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground)); }
  .transcript { flex: 1; overflow: auto; padding: 0 14px 12px; display: flex; flex-direction: column; gap: 12px; line-height: 1.5; }
  .quote { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); border-radius: 4px; padding: 8px 10px; }
  .msg { white-space: pre-wrap; word-break: break-word; }
  .msg.user { padding: 6px 10px; border-radius: 4px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .tools { font-family: var(--mono); font-size: 12px; color: var(--vscode-descriptionForeground); }
  .note { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .followup { padding: 12px 14px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
  .followup label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .followup input { width: 100%; min-height: 28px; padding: 0 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
  .followup input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  @media (max-width: 760px) {
    .main { flex-direction: column; }
    aside { width: auto; border-left: 0; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); max-height: 45%; }
  }
`,
    body: `
<header>
  <div class="head">
    <div class="meta" id="meta"></div>
    <h1 id="title"></h1>
    <div class="state" id="state"></div>
  </div>
  <div class="actions">
    <button class="btn" id="worktree" type="button">Open Worktree</button>
    <button class="btn" id="sendback" type="button">Send Back…</button>
    <button class="btn primary" id="merge" type="button" hidden>Merge</button>
  </div>
</header>
<div id="banners"></div>
<div class="main">
  <section class="diffpane" aria-label="Changes">
    <div class="tabbar">
      <div class="tabs" id="tabs" role="tablist"></div>
      <div class="tabtools"><button class="link" id="opendiff" type="button" hidden>Open Diff</button></div>
    </div>
    <div class="diff" id="diff" role="tabpanel"></div>
  </section>
  <aside aria-label="Run transcript">
    <div class="aside-head"><h2>Transcript</h2><button class="link" id="openchat" type="button">Open Chat</button></div>
    <div class="transcript" id="transcript" aria-live="polite"></div>
    <form class="followup" id="followup">
      <label for="ask">Follow-up</label>
      <input id="ask" type="text" placeholder="Ask for a change…" autocomplete="off" />
    </form>
  </aside>
</div>
`,
    script: `
  const $ = id => document.getElementById(id);
  const post = msg => vscode.postMessage(msg);
  $('worktree').addEventListener('click', () => post({ type: 'openWorktree' }));
  $('sendback').addEventListener('click', () => post({ type: 'sendBack' }));
  $('merge').addEventListener('click', () => post({ type: 'merge' }));
  $('opendiff').addEventListener('click', () => post({ type: 'openDiff' }));
  $('openchat').addEventListener('click', () => post({ type: 'openChat' }));
  $('followup').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('ask').value.trim();
    if (!text) return;
    post({ type: 'followup', text });
    $('ask').value = '';
  });

  function header(h) {
    $('meta').textContent = h.meta;
    $('title').textContent = h.title;
    $('state').textContent = h.stateLabel;
    $('worktree').disabled = !h.canOpenWorktree;
    $('worktree').title = h.canOpenWorktree ? 'Open the run\\'s worktree in a new window' : 'The worktree is not on this machine';
    $('sendback').disabled = !h.canSendBack;
    const merge = $('merge');
    merge.hidden = h.prNumber === undefined;
    merge.disabled = !h.canMerge;
    merge.textContent = h.prNumber === undefined ? 'Merge' : 'Merge PR #' + h.prNumber;
    $('ask').disabled = !h.canSendBack;
    const banners = $('banners');
    banners.replaceChildren();
    if (h.awaiting) {
      const isQ = h.awaiting.kind === 'question';
      banners.append(el('div', { class: 'banner warn', role: 'status' },
        el('div', { class: 'text' }, el('strong', {}, isQ ? 'The agent asks: ' : 'Waiting for approval: '), h.awaiting.text, h.awaiting.preview ? el('pre', {}, h.awaiting.preview) : null),
        isQ ? el('button', { class: 'btn primary', type: 'button', onclick: () => post({ type: 'answer' }) }, 'Answer…')
          : [el('button', { class: 'btn primary', type: 'button', onclick: () => post({ type: 'approve', decision: 'approve' }) }, 'Approve'),
            el('button', { class: 'btn', type: 'button', onclick: () => post({ type: 'approve', decision: 'reject' }) }, 'Deny')]));
    }
    if (h.error) banners.append(el('div', { class: 'banner err', role: 'alert' }, el('div', { class: 'text' }, h.error)));
    if (h.activity) banners.append(el('div', { class: 'banner' }, el('div', { class: 'text muted mono' }, h.activity)));
    if (h.note) banners.append(el('div', { class: 'banner' }, el('div', { class: 'text muted' }, h.note)));
  }

  function files(f) {
    const tabs = $('tabs');
    tabs.replaceChildren();
    for (const file of f.files) {
      const name = file.path.split('/').pop();
      const active = file.path === f.selected;
      tabs.append(el('button', {
        class: 'tab' + (active ? ' active' : ''), type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false', title: file.path,
        onclick: () => post({ type: 'selectFile', path: file.path }),
      }, name, file.binary ? null : [el('span', { class: 'add' }, '+' + file.additions), el('span', { class: 'del' }, '\\u2212' + file.deletions)]));
    }
    $('opendiff').hidden = !f.canOpenDiff;
    $('opendiff').textContent = f.source === 'github' ? 'Open on GitHub' : 'Open Diff';
    if (f.message) $('diff').replaceChildren(el('div', { class: 'empty' }, f.message));
  }

  function diff(d) {
    const box = $('diff');
    if (!d.path) return;
    if (d.message && !d.lines.length) { box.replaceChildren(el('div', { class: 'empty' }, d.message)); return; }
    const frag = document.createDocumentFragment();
    for (const l of d.lines) {
      if (l.kind === 'hunk') { frag.append(el('div', { class: 'line hunk' }, el('span', { class: 'ln' }, ''), el('span', { class: 'sign' }, ''), l.text)); continue; }
      frag.append(el('div', { class: 'line ' + l.kind },
        el('span', { class: 'ln' }, l.line === undefined ? '' : l.line),
        el('span', { class: 'sign' }, l.kind === 'add' ? '+' : l.kind === 'del' ? '\\u2212' : ''),
        el('span', {}, l.text)));
    }
    if (d.truncated) frag.append(el('div', { class: 'empty' }, 'Diff truncated: use Open Diff for the whole file.'));
    box.replaceChildren(frag);
    box.scrollTop = 0;
  }

  function transcript(t) {
    const box = $('transcript');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.replaceChildren();
    box.append(el('div', { class: 'quote' }, t.issueNumber !== undefined ? 'From issue #' + t.issueNumber + ': \\u201c' + t.quote + '\\u201d' : t.quote));
    for (const item of t.items) {
      if (item.kind === 'assistant') box.append(el('div', { class: 'msg' }, item.text));
      else if (item.kind === 'user') box.append(el('div', { class: 'msg user' }, item.text));
      else if (item.kind === 'tools') box.append(el('div', { class: 'tools' }, item.lines.map((line, i) => [i ? el('br', {}) : null, line])));
      else if (item.kind === 'error') box.append(el('div', { class: 'error' }, item.text));
      else box.append(el('div', { class: 'note' }, item.text));
    }
    if (t.pr) box.append(el('div', {}, el('button', { class: 'link', type: 'button', onclick: () => post({ type: 'openLink', which: 'pr' }) }, 'Opened PR #' + t.pr.number)));
    if (t.message) box.append(el('div', { class: 'note' }, t.message));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'header') header(m);
    else if (m.type === 'files') files(m);
    else if (m.type === 'diff') diff(m);
    else if (m.type === 'transcript') transcript(m);
  });
  post({ type: 'ready' });
`,
  });
}
