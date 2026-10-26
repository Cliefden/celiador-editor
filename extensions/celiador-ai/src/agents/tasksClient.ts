/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { Auth } from '../auth';
import type { SessionEvent, Task, TaskList } from './model';

// The Agents view's line to the daemon's task queue (agents UI contract §1/§3):
// list + live stream of tasks, create from an issue, follow-up, merge, and the
// linked relay session's event log. Same Bearer(Supabase JWT) as the rest of
// the extension; a 401 refreshes once and retries.

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** An HTTP error from the daemon, with its status (409 = no session / editor offline). */
export class DaemonError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Read a `text/event-stream` response, calling `onEvent(event, data)` per frame
 * (event defaults to "message"). Resolves when the stream ends.
 */
export async function readSse(res: Response, onEvent: (event: string, data: string) => void): Promise<void> {
  if (!res.body) {return;}
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {break;}
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (line === '') {
        if (data.length) {onEvent(event, data.join('\n'));}
        event = 'message';
        data = [];
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
}

/** Authenticated calls to the daemon's task + session endpoints. */
export class TasksClient {
  constructor(private readonly auth: Auth, private readonly baseUrl: () => string) {}

  async signedIn(): Promise<boolean> {
    return this.auth.isSignedIn();
  }

  /** fetch() with the Bearer token; refreshes once on a 401. */
  async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) };
    if (init.body) {headers['content-type'] = 'application/json';}
    const res = await fetch(`${this.baseUrl()}${path}`, { ...init, headers });
    if (res.status === 401 && retry && (await this.auth.tryRefresh())) {
      return this.request(path, init, false);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, { ...init, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {throw new DaemonError(body.error || `HTTP ${res.status}`, res.status);}
    return body;
  }

  async list(): Promise<TaskList> {
    const body = await this.json<{ tasks?: Task[]; concurrency?: number }>('/api/tasks');
    return { tasks: Array.isArray(body.tasks) ? body.tasks : [], concurrency: typeof body.concurrency === 'number' ? body.concurrency : 0 };
  }

  /** Queue a task; `deduped` = that issue already had an open task, which comes back instead. */
  async create(input: { remoteUrl: string; title: string; details?: string; issue?: { number: number; title: string; url: string } }): Promise<{ task?: Task; deduped: boolean }> {
    const body = await this.json<{ task?: Task; deduped?: boolean }>('/api/tasks', { method: 'POST', body: JSON.stringify(input) });
    return { task: body.task, deduped: body.deduped === true };
  }

  async followup(taskId: string, text: string): Promise<void> {
    await this.json(`/api/tasks/${encodeURIComponent(taskId)}/followup`, { method: 'POST', body: JSON.stringify({ text }) });
  }

  async merge(taskId: string, method?: 'merge' | 'squash' | 'rebase'): Promise<{ ok?: boolean; merged?: boolean; url?: string }> {
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}/merge`, { method: 'POST', body: JSON.stringify(method ? { method } : {}) });
  }

  /** Send a turn straight to a relay session (older daemons without `/followup`). */
  async sessionMessage(sessionId: string, text: string): Promise<void> {
    await this.json(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { method: 'POST', body: JSON.stringify({ text }) });
  }

  /** Approve or deny what a task's session is waiting on (`awaiting.requestId`). */
  async decide(sessionId: string, requestId: string, decision: 'approve' | 'reject'): Promise<void> {
    await this.json(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}`, { method: 'POST', body: JSON.stringify({ decision }) });
  }

  /** Answer a task session's question. */
  async answer(sessionId: string, requestId: string, text: string): Promise<void> {
    await this.json(`/api/sessions/${encodeURIComponent(sessionId)}/answers/${encodeURIComponent(requestId)}`, { method: 'POST', body: JSON.stringify({ text }) });
  }

  /** Tell the daemon a task's PR was merged here (the relay fallback merge). */
  async reportMerged(taskId: string): Promise<void> {
    await this.json(`/api/tasks/${encodeURIComponent(taskId)}/status`, { method: 'POST', body: JSON.stringify({ state: 'merged' }) });
  }

  /** Stream a relay session's event log (replay, then live) until `signal` aborts. */
  async sessionEvents(sessionId: string, onEvent: (ev: SessionEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/events`, { headers: { Accept: 'text/event-stream' }, signal });
    if (!res.ok) {throw new DaemonError(`HTTP ${res.status}`, res.status);}
    await readSse(res, (event, data) => {
      if (event !== 'message') {return;}
      try {
        onEvent(JSON.parse(data) as SessionEvent);
      } catch {
        /* skip a malformed frame */
      }
    });
  }
}

/**
 * The live task list: `GET /api/tasks` plus the `/api/tasks/stream` SSE feed,
 * reconnecting with backoff (and re-listing on every reconnect, so nothing
 * missed while offline is lost). Dormant while signed out.
 */
export class TaskFeed implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private tasks = new Map<string, Task>();
  private concurrency = 0;
  private abort: AbortController | undefined;
  private running = false;
  private wasSignedIn: boolean | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Why the list is empty, when it is for a reason (signed out, unreachable). */
  status: 'signed-out' | 'connecting' | 'live' | 'offline' = 'connecting';

  constructor(private readonly client: TasksClient, auth: Auth) {
    this.disposables.push(this.changed, auth.onDidChange(() => void this.onAuthChange()));
    void this.onAuthChange();
  }

  get list(): TaskList {
    return { tasks: [...this.tasks.values()], concurrency: this.concurrency };
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** Apply a task the client changed itself (the stream will confirm it). */
  upsert(task: Task): void {
    this.tasks.set(task.id, task);
    this.changed.fire();
  }

  /** Re-list now (the Refresh command). */
  async refresh(): Promise<void> {
    if (!(await this.client.signedIn())) {return;}
    try {
      const list = await this.client.list();
      this.tasks = new Map(list.tasks.map((t) => [t.id, t]));
      this.concurrency = list.concurrency;
      this.changed.fire();
    } catch {
      /* the stream loop reports offline */
    }
  }

  private async onAuthChange(): Promise<void> {
    const signedIn = await this.client.signedIn();
    if (signedIn === this.wasSignedIn) {return;} // a token refresh, not a sign-in change
    this.wasSignedIn = signedIn;
    this.abort?.abort();
    if (!signedIn) {
      this.tasks.clear();
      this.status = 'signed-out';
      this.changed.fire();
      return;
    }
    this.status = 'connecting';
    this.changed.fire();
    if (!this.running) {void this.loop();}
  }

  private async loop(): Promise<void> {
    this.running = true;
    let backoff = MIN_BACKOFF_MS;
    try {
      while (this.wasSignedIn) {
        const abort = new AbortController();
        this.abort = abort;
        try {
          const list = await this.client.list();
          this.tasks = new Map(list.tasks.map((t) => [t.id, t]));
          this.concurrency = list.concurrency;
          const res = await this.client.request('/api/tasks/stream', { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
          if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
          this.status = 'live';
          this.changed.fire();
          backoff = MIN_BACKOFF_MS;
          await readSse(res, (event, data) => {
            if (event !== 'task') {return;}
            try {
              const task = JSON.parse(data) as Task;
              if (task?.id) {
                this.tasks.set(task.id, task);
                this.changed.fire();
              }
            } catch {
              /* skip a malformed frame */
            }
          });
        } catch {
          /* fall through to backoff */
        }
        if (!this.wasSignedIn) {break;}
        if (this.status !== 'offline') {
          this.status = 'offline';
          this.changed.fire();
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.wasSignedIn = false;
    this.abort?.abort();
    for (const d of this.disposables) {d.dispose();}
  }
}
