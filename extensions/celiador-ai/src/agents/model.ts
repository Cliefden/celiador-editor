/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure data helpers for the Agents view: the daemon's task shape (agents UI
// contract §1), the sidebar buckets, run subtitles, and parsers for git's
// numstat / unified diff output and the relay session's event log. No vscode
// import, so they unit-test under plain node.

export type TaskState = 'queued' | 'dispatched' | 'running' | 'pr-open' | 'merged' | 'failed' | 'cancelled';

/** A task as `GET /api/tasks` returns it. Fields past `updatedAt` are optional (newer daemons). */
export interface Task {
  id: string;
  repo: { owner: string; name: string; url: string };
  issue?: { number: number; title: string; url: string };
  title: string;
  prompt?: string;
  branch: string;
  source?: string;
  state: TaskState;
  sessionId?: string;
  prUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  runner?: 'mac' | 'cloud';
  machine?: string;
  startedAt?: string;
  finishedAt?: string;
  activity?: string;
  awaiting?: { kind: 'permission' | 'question'; requestId: string; text: string; preview?: string; choices?: string[] };
  pr?: {
    number: number;
    url: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    checks?: 'passing' | 'failing' | 'pending' | 'none' | 'unknown';
    mergeable?: boolean;
    updatedAt?: string;
  };
  /** The linked session's usage (stand-out contract §1): what the run cost so far. */
  usage?: { requests?: number; inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** `GET /api/tasks`. */
export interface TaskList {
  tasks: Task[];
  concurrency: number;
}

export type BucketId = 'needs-you' | 'ready' | 'running' | 'merged-today' | 'failed-today';

export interface Bucket {
  id: BucketId;
  label: string;
  tasks: Task[];
}

const BUCKET_LABELS: Record<BucketId, string> = {
  'needs-you': 'Needs you',
  ready: 'Ready to merge',
  running: 'Running',
  'merged-today': 'Merged today',
  'failed-today': 'Failed today',
};

function sameLocalDay(iso: string | undefined, now: Date): boolean {
  if (!iso) {return false;}
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

const isTerminal = (s: TaskState) => s === 'pr-open' || s === 'merged' || s === 'failed' || s === 'cancelled';

/**
 * The sidebar groups (contract §1): Needs you = blocked on the user; Ready to
 * merge = pr-open; Running = queued/dispatched/running; Merged today. Today's
 * failures get a muted group of their own so a broken run doesn't just vanish.
 * Empty groups are left out; newest first within each.
 */
export function bucketTasks(tasks: readonly Task[], now = new Date()): Bucket[] {
  const groups: Record<BucketId, Task[]> = { 'needs-you': [], ready: [], running: [], 'merged-today': [], 'failed-today': [] };
  for (const t of tasks) {
    if (t.awaiting && !isTerminal(t.state)) {groups['needs-you'].push(t);}
    else if (t.state === 'pr-open') {groups.ready.push(t);}
    else if (t.state === 'queued' || t.state === 'dispatched' || t.state === 'running') {groups.running.push(t);}
    else if (t.state === 'merged' && sameLocalDay(t.finishedAt ?? t.updatedAt, now)) {groups['merged-today'].push(t);}
    else if (t.state === 'failed' && sameLocalDay(t.finishedAt ?? t.updatedAt, now)) {groups['failed-today'].push(t);}
  }
  const newest = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);
  return (Object.keys(groups) as BucketId[])
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, label: BUCKET_LABELS[id], tasks: groups[id].sort(newest) }));
}

/** Slots in use: dispatched + running, of the daemon's `concurrency`. */
export function busySlots(tasks: readonly Task[]): number {
  return tasks.filter((t) => t.state === 'dispatched' || t.state === 'running').length;
}

/** The view's header description, e.g. "2 of 3 slots busy". */
export function slotsLabel(list: TaskList): string {
  return `${busySlots(list.tasks)} of ${list.concurrency} slot${list.concurrency === 1 ? '' : 's'} busy`;
}

/** The pull request number of a task: `pr.number`, else parsed from `prUrl`. */
export function prNumber(task: Task): number | undefined {
  if (typeof task.pr?.number === 'number') {return task.pr.number;}
  const m = /\/pull\/(\d+)/.exec(task.prUrl ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Where a task runs, for its subtitle: "this Mac", another machine's name, or "cloud". */
export function whereLabel(task: Task, localMachine: string | undefined): string {
  if (task.runner === 'cloud') {return 'cloud';}
  if (!task.machine || (localMachine && task.machine === localMachine)) {return 'this Mac';}
  return task.machine;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "$0.38"; "<$0.01" for a run that cost something but rounds to nothing. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) {return '<$0.01';}
  return `$${usd.toFixed(2)}`;
}

/** The run's cost for a row or meta line (" · $0.38"), empty until the daemon reports one. */
function costTail(task: Task): string {
  const usd = task.usage?.costUsd;
  return typeof usd === 'number' && Number.isFinite(usd) ? ` · ${formatCost(usd)}` : '';
}

/** The mono second line of a sidebar row: `<branch> · <what it waits on | where | PR #n>[ · $cost]`. */
export function taskSubtitle(task: Task, localMachine: string | undefined): string {
  let tail: string;
  if (task.awaiting && !isTerminal(task.state)) {
    tail = task.awaiting.kind === 'question' ? `asks: ${clip(task.awaiting.text, 60)}` : `wants: ${clip(task.awaiting.text, 60)}`;
  } else if (task.state === 'pr-open' || task.state === 'merged') {
    const n = prNumber(task);
    tail = n !== undefined ? `PR #${n}` : task.state === 'merged' ? 'merged' : 'PR open';
  } else if (task.state === 'queued') {
    tail = 'queued';
  } else if (task.state === 'failed') {
    tail = task.error ? clip(task.error, 60) : 'failed';
  } else {
    tail = whereLabel(task, localMachine);
  }
  return `${task.branch} · ${tail}${costTail(task)}`;
}

/** "12 min", "1 h 5 min", "<1 min" between two instants. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {return '<1 min';}
  if (minutes < 60) {return `${minutes} min`;}
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The run panel's mono meta line: "Issue #49 · worktree <branch> · ran on this Mac, 12 min[ · $0.38]". */
export function runMeta(task: Task, localMachine: string | undefined, now = Date.now()): string {
  const parts: string[] = [];
  if (task.issue) {parts.push(`Issue #${task.issue.number}`);}
  parts.push(`worktree ${task.branch}`);
  const where = whereLabel(task, localMachine);
  const start = task.startedAt ? Date.parse(task.startedAt) : undefined;
  const running = task.state === 'running' || task.state === 'dispatched';
  const end = running ? now : task.finishedAt ? Date.parse(task.finishedAt) : undefined;
  const took = start !== undefined && end !== undefined && end >= start ? `, ${formatDuration(end - start)}` : '';
  if (task.state === 'queued') {parts.push('queued');}
  else {parts.push(`${running ? 'running on' : 'ran on'} ${where === 'cloud' ? 'the cloud' : where}${took}`);}
  return `${parts.join(' · ')}${costTail(task)}`;
}

// --- git output ---------------------------------------------------------------

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Parse `git diff --numstat` (renames as `old => new` keep the new path). */
export function parseNumstat(stdout: string): FileStat[] {
  const files: FileStat[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) {continue;}
    let path = m[3];
    // "dir/{old => new}/file" or "old => new"
    const brace = /^(.*)\{(?:.*) => (.*)\}(.*)$/.exec(path);
    if (brace) {path = `${brace[1]}${brace[2]}${brace[3]}`.replace(/\/\//g, '/');}
    else if (path.includes(' => ')) {path = path.split(' => ')[1];}
    const binary = m[1] === '-';
    files.push({ path, additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return files;
}

export type DiffLineKind = 'context' | 'add' | 'del' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the new file (context/add) or the old file (del). */
  line?: number;
}

/** A unified diff → display lines (file headers dropped, hunks kept as separators). */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) {continue;}
    if (raw.startsWith('diff --git ')) {inHunk = false; continue;}
    if (raw.startsWith('\\')) {continue;} // "\ No newline at end of file"
    if (raw.startsWith('+')) {out.push({ kind: 'add', text: raw.slice(1), line: newLine++ });}
    else if (raw.startsWith('-')) {out.push({ kind: 'del', text: raw.slice(1), line: oldLine++ });}
    else {out.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw, line: newLine++ }); oldLine++;}
  }
  // A trailing empty context line comes from the patch's final newline.
  if (out.length && out[out.length - 1].kind === 'context' && out[out.length - 1].text === '') {out.pop();}
  return out;
}

// --- the relay session's event log ---------------------------------------------

/** One event of `GET /api/sessions/:id/events` (the kinds the transcript uses). */
export interface SessionEvent {
  seq?: number;
  kind: string;
  text?: string;
  role?: 'user' | 'assistant';
  name?: string;
  input?: unknown;
  title?: string;
  prompt?: string;
  message?: string;
}

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tools'; lines: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

/** "Read · SessionView.swift" when the tool's input names a file or command, else the tool name. */
export function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const detail = [i.file_path, i.path, i.command, i.pattern, i.url].find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  if (!detail) {return name;}
  const short = /[/\\]/.test(detail) && !/\s/.test(detail) ? detail.split(/[/\\]/).pop()! : clip(detail, 48);
  return `${name} · ${short}`;
}

/**
 * Fold the session's event log into transcript items: streamed deltas join
 * into one assistant message per stretch, consecutive tool calls become one
 * compact tool log, and approvals / questions / errors become short notes.
 * The first user turn is the task's prompt (shown as the issue quote), so it
 * is skipped when `skipFirstUser` is set.
 */
export function buildTranscript(events: readonly SessionEvent[], skipFirstUser = true): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let text = '';
  let skippedUser = !skipFirstUser;
  const flush = () => {
    const t = text.trim();
    if (t) {items.push({ kind: 'assistant', text: t });}
    text = '';
  };
  for (const ev of events) {
    switch (ev.kind) {
      case 'delta':
        text += ev.text ?? '';
        break;
      case 'message':
        if (ev.role === 'user') {
          flush();
          if (!skippedUser) {skippedUser = true; break;}
          if (ev.text?.trim()) {items.push({ kind: 'user', text: ev.text.trim() });}
        } else if (ev.text?.trim()) {
          // A whole assistant message replaces the deltas that streamed it.
          text = '';
          items.push({ kind: 'assistant', text: ev.text.trim() });
        }
        break;
      case 'tool': {
        flush();
        const line = toolLine(ev.name ?? 'Tool', ev.input);
        const last = items[items.length - 1];
        if (last?.kind === 'tools') {last.lines.push(line);}
        else {items.push({ kind: 'tools', lines: [line] });}
        break;
      }
      case 'approval':
        flush();
        if (ev.title) {items.push({ kind: 'note', text: `Asked to approve: ${clip(ev.title, 120)}` });}
        break;
      case 'question':
        flush();
        if (ev.prompt) {items.push({ kind: 'note', text: `Asked: ${clip(ev.prompt, 160)}` });}
        break;
      case 'error':
        flush();
        items.push({ kind: 'error', text: ev.message ?? 'The run hit an error.' });
        break;
      case 'done':
        flush();
        break;
      default:
        break;
    }
  }
  flush();
  return items;
}

/**
 * The issue quote's text: the first paragraph of the issue body (or manual
 * details) inside the daemon's prompt — "Issue description:\n…" — else the
 * task title, clipped.
 */
export function issueQuote(task: Task): string {
  const m = /\n(?:Issue description|Details):\n([\s\S]*?)(?:\n\nKeep the change focused[\s\S]*)?$/.exec(task.prompt ?? '');
  const first = m?.[1].split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0 && !p.startsWith('#'));
  return clip(first ?? task.issue?.title ?? task.title, 280);
}
