/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

// The relay's run-review executor. The workbench relay bridge receives `git.*`
// commands from the phone (via the daemon) and delegates here over the
// `celiador.relayGit` command — the extension host has the vscode.git extension
// API, so status/diff/commit/discard/push run through the editor's own git
// machinery (no raw process spawning, honors the user's git config, hooks and
// credentials), and a pull request is opened with the editor's GitHub sign-in.

/** Arguments the bridge passes through from the relayed git.* command. */
interface GitReviewArgs {
  kind: 'git.status' | 'git.diff' | 'git.commit' | 'git.revert' | 'git.push' | 'git.pr';
  path?: string;
  message?: string;
  paths?: string[];
  title?: string;
  body?: string;
  base?: string;
  /** Celiador agent task: the run's own worktree; the main checkout when unset. */
  root?: string;
}

/** The `fs.result` payload (minus requestId, which the bridge owns). */
interface GitReviewResult {
  ok: boolean;
  error?: string;
  branch?: string;
  files?: Array<{ path: string; status: string }>;
  patch?: string;
  sha?: string;
  remote?: string;
  url?: string;
  created?: boolean;
}

// Minimal slices of the vscode.git API (extensions/git/src/api/git.d.ts).
interface GitChange {
  uri: vscode.Uri;
  status: number;
}
interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD: { name?: string; upstream?: { remote: string; name: string } } | undefined;
    remotes: GitRemote[];
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges: GitChange[];
  };
  status(): Promise<void>;
  diffWithHEAD(path: string): Promise<string>;
  add(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  getCommit(ref: string): Promise<{ hash: string }>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

/** The remote a branch should go to: its upstream if set, else origin, else the first one. */
function pickRemote(repo: GitRepository): GitRemote | undefined {
  const upstream = repo.state.HEAD?.upstream?.remote;
  const remotes = repo.state.remotes;
  return (upstream ? remotes.find((r) => r.name === upstream) : undefined) ?? remotes.find((r) => r.name === 'origin') ?? remotes[0];
}

/** `owner/repo` from a GitHub remote URL (https or ssh); undefined for other hosts. */
function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) {return undefined;}
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/**
 * Open (or find) the pull request for `head` with the editor's GitHub sign-in.
 * Without a signed-in GitHub session we don't prompt from a background relay
 * command — the phone gets a compare link to finish in the browser instead.
 */
async function openPullRequest(target: { owner: string; repo: string }, head: string, args: GitReviewArgs): Promise<GitReviewResult> {
  const title = args.title!.trim();
  const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
  const compareUrl = `https://github.com/${target.owner}/${target.repo}/compare/${encodeURIComponent(head)}?expand=1&title=${encodeURIComponent(title)}`;
  if (!session) {return { ok: true, url: compareUrl, created: false };}

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'celiador-editor',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const repoPath = `/repos/${target.owner}/${target.repo}`;
  let base = args.base?.trim();
  if (!base) {
    const info = await api('GET', repoPath);
    base = typeof info.json?.default_branch === 'string' ? info.json.default_branch : 'main';
  }
  const created = await api('POST', `${repoPath}/pulls`, { title, body: args.body ?? '', head, base });
  if (created.status === 201 && typeof created.json?.html_url === 'string') {
    return { ok: true, url: created.json.html_url, created: true };
  }
  // Already open for this branch? Hand back the existing one.
  const existing = await api('GET', `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${head}`)}`);
  if (Array.isArray(existing.json) && typeof existing.json[0]?.html_url === 'string') {
    return { ok: true, url: existing.json[0].html_url, created: false };
  }
  const detail = created.json?.errors?.[0]?.message ?? created.json?.message;
  return { ok: false, error: typeof detail === 'string' ? detail : `GitHub returned ${created.status}` };
}
interface GitAPI {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

/** vscode.git `Status` enum → the short code the phone renders. */
const STATUS_CODE: Record<number, string> = {
  0: 'M', // INDEX_MODIFIED
  1: 'A', // INDEX_ADDED
  2: 'D', // INDEX_DELETED
  3: 'R', // INDEX_RENAMED
  4: 'C', // INDEX_COPIED
  5: 'M', // MODIFIED
  6: 'D', // DELETED
  7: 'U', // UNTRACKED
  9: 'A', // INTENT_TO_ADD
  10: 'R', // INTENT_TO_RENAME
  11: 'M', // TYPE_CHANGED
};
const IGNORED = 8;

async function getRepo(root?: string): Promise<GitRepository> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) {throw new Error('git is not available');}
  const api = (await ext.activate() as { getAPI(version: number): GitAPI }).getAPI(1);
  // An agent task runs in its own worktree: open that repository rather than the window's.
  const repo = root
    ? api.getRepository(vscode.Uri.file(root)) ?? await api.openRepository(vscode.Uri.file(root))
    : api.repositories[0];
  if (!repo) {throw new Error(root ? `no git repository at ${root}` : 'no git repository open');}
  return repo;
}

/** Workspace-relative path for a changed file (repo-root relative, / separators). */
function relPath(repo: GitRepository, uri: vscode.Uri): string {
  const root = repo.rootUri.path.replace(/\/+$/, '');
  return uri.path.startsWith(`${root}/`) ? uri.path.slice(root.length + 1) : uri.path;
}

/** Resolve a repo-relative path to an absolute fsPath, rejecting `..` escapes. */
function absPath(repo: GitRepository, rel: string): string {
  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {throw new Error('bad path');}
  return vscode.Uri.joinPath(repo.rootUri, ...segments).fsPath;
}

/** All changed files (index + working tree + untracked), de-duped, ignored skipped. */
function changedFiles(repo: GitRepository): Array<{ path: string; status: string }> {
  const seen = new Map<string, string>();
  const groups = [repo.state.indexChanges, repo.state.workingTreeChanges, repo.state.untrackedChanges];
  for (const group of groups) {
    for (const change of group) {
      if (change.status === IGNORED) {continue;}
      const path = relPath(repo, change.uri);
      if (!seen.has(path)) {seen.set(path, STATUS_CODE[change.status] ?? 'M');}
    }
  }
  return [...seen.entries()].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

/** A pseudo-patch for a file git can't diff yet (untracked): whole file as added. */
async function untrackedPatch(repo: GitRepository, rel: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(repo.rootUri, ...rel.split('/')));
  const text = new TextDecoder().decode(bytes);
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

async function execute(args: GitReviewArgs): Promise<GitReviewResult> {
  const repo = await getRepo(args.root);
  switch (args.kind) {
    case 'git.status': {
      await repo.status(); // refresh so the phone sees the current tree, not a cached one
      return { ok: true, branch: repo.state.HEAD?.name, files: changedFiles(repo) };
    }
    case 'git.diff': {
      if (!args.path) {
        // Whole-run diff: concatenate per-file patches (keeps untracked files included).
        await repo.status();
        const parts: string[] = [];
        for (const file of changedFiles(repo)) {
          parts.push(file.status === 'U' ? await untrackedPatch(repo, file.path) : await repo.diffWithHEAD(file.path));
        }
        return { ok: true, patch: parts.filter((p) => p.length > 0).join('\n') };
      }
      const abs = absPath(repo, args.path);
      try {
        const patch = await repo.diffWithHEAD(abs);
        if (patch.length > 0) {return { ok: true, patch };}
      } catch {
        /* fall through to the untracked pseudo-patch */
      }
      return { ok: true, patch: await untrackedPatch(repo, args.path) };
    }
    case 'git.commit': {
      if (!args.message) {return { ok: false, error: 'message is required' };}
      await repo.status();
      const targets = args.paths?.length ? args.paths : changedFiles(repo).map((f) => f.path);
      if (!targets.length) {return { ok: false, error: 'nothing to commit' };}
      await repo.add(targets.map((p) => absPath(repo, p)));
      await repo.commit(args.message);
      const sha = await repo.getCommit('HEAD').then((c) => c.hash, () => undefined);
      return { ok: true, sha };
    }
    case 'git.revert': {
      if (!args.paths?.length) {return { ok: false, error: 'paths are required' };}
      // clean() discards: checkout for tracked changes, delete for untracked files.
      await repo.clean(args.paths.map((p) => absPath(repo, p)));
      return { ok: true };
    }
    case 'git.push': {
      await repo.status();
      const branch = repo.state.HEAD?.name;
      if (!branch) {return { ok: false, error: 'detached HEAD — check out a branch first' };}
      const remote = pickRemote(repo);
      if (!remote) {return { ok: false, error: 'no git remote configured' };}
      await repo.push(remote.name, branch, true);
      return { ok: true, branch, remote: remote.name };
    }
    case 'git.pr': {
      if (!args.title?.trim()) {return { ok: false, error: 'title is required' };}
      await repo.status();
      const branch = repo.state.HEAD?.name;
      if (!branch) {return { ok: false, error: 'detached HEAD — check out a branch first' };}
      const remote = pickRemote(repo);
      const target = parseGitHubRemote(remote?.pushUrl ?? remote?.fetchUrl);
      if (!target) {return { ok: false, error: `the branch's remote is not on GitHub` };}
      return openPullRequest(target, branch, args);
    }
  }
}

/** Register the command the workbench relay bridge delegates git.* commands to. */
export function registerGitReview(): vscode.Disposable {
  return vscode.commands.registerCommand('celiador.relayGit', async (args: GitReviewArgs): Promise<GitReviewResult> => {
    try {
      return await execute(args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// --- Agent tasks (issue → worktree run → pull request) -----------------------

/** What the editor control asks for when a task's run has finished. */
interface FinishTaskArgs {
  /** The run's worktree. */
  root: string;
  title: string;
  issue?: { number: number; url: string };
}

/** The worktree checked out on `branch` under the repository at `repoRoot`, if any. */
async function worktreeForBranch(repoRoot: string, branch: string): Promise<string | undefined> {
  const { execFile } = await import('child_process');
  const out = await new Promise<string>((resolve, reject) =>
    execFile('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
  let current: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line === `branch refs/heads/${branch}`) {
      return current;
    }
  }
  return undefined;
}

/**
 * Finish an agent task: commit whatever the agent left uncommitted, push the
 * branch, and open its pull request (`Closes #n` when it came from an issue).
 * Uses the user's git identity, hooks and credentials, and the editor's GitHub
 * sign-in — without one, a compare link comes back instead (`created: false`).
 */
async function finishTask(args: FinishTaskArgs): Promise<GitReviewResult> {
  const repo = await getRepo(args.root);
  await repo.status();
  const branch = repo.state.HEAD?.name;
  if (!branch) {return { ok: false, error: 'the run left a detached HEAD' };}
  const leftovers = changedFiles(repo);
  if (leftovers.length) {
    await repo.add(leftovers.map((f) => absPath(repo, f.path)));
    await repo.commit(args.issue ? `${args.title} (#${args.issue.number})` : args.title);
  }
  const remote = pickRemote(repo);
  const target = parseGitHubRemote(remote?.pushUrl ?? remote?.fetchUrl);
  if (!remote || !target) {return { ok: false, error: `the repository's remote is not on GitHub` };}
  await repo.push(remote.name, branch, true);
  const body = args.issue ? `Closes #${args.issue.number}` : '';
  const pr = await openPullRequest(target, branch, { kind: 'git.pr', title: args.title, body });
  if (!pr.ok && /no commits between/i.test(pr.error ?? '')) {
    return { ok: false, error: 'the agent made no changes' };
  }
  return { ...pr, branch };
}

/** Register the agent-task commands the workbench's editor control calls. */
export function registerTaskCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('celiador.taskWorktree', async (args: { repoRoot: string; branch: string }): Promise<string | undefined> => {
      try {
        return await worktreeForBranch(args.repoRoot, args.branch);
      } catch {
        return undefined;
      }
    }),
    vscode.commands.registerCommand('celiador.finishTask', async (args: FinishTaskArgs): Promise<GitReviewResult> => {
      try {
        return await finishTask(args);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
