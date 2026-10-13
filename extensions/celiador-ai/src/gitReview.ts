import * as vscode from "vscode";

// The relay's run-review executor. The workbench relay bridge receives `git.*`
// commands from the phone (via the daemon) and delegates here over the
// `celiador.relayGit` command — the extension host has the vscode.git extension
// API, so status/diff/commit/discard run through the editor's own git machinery
// (no raw process spawning, honors the user's git config and hooks).

/** Arguments the bridge passes through from the relayed git.* command. */
interface GitReviewArgs {
  kind: "git.status" | "git.diff" | "git.commit" | "git.revert";
  path?: string;
  message?: string;
  paths?: string[];
}

/** The `fs.result` payload (minus requestId, which the bridge owns). */
interface GitReviewResult {
  ok: boolean;
  error?: string;
  branch?: string;
  files?: Array<{ path: string; status: string }>;
  patch?: string;
  sha?: string;
}

// Minimal slices of the vscode.git API (extensions/git/src/api/git.d.ts).
interface GitChange {
  uri: vscode.Uri;
  status: number;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD: { name?: string } | undefined;
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
}
interface GitAPI {
  repositories: GitRepository[];
}

/** vscode.git `Status` enum → the short code the phone renders. */
const STATUS_CODE: Record<number, string> = {
  0: "M", // INDEX_MODIFIED
  1: "A", // INDEX_ADDED
  2: "D", // INDEX_DELETED
  3: "R", // INDEX_RENAMED
  4: "C", // INDEX_COPIED
  5: "M", // MODIFIED
  6: "D", // DELETED
  7: "U", // UNTRACKED
  9: "A", // INTENT_TO_ADD
  10: "R", // INTENT_TO_RENAME
  11: "M", // TYPE_CHANGED
};
const IGNORED = 8;

async function getRepo(): Promise<GitRepository> {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) throw new Error("git is not available");
  const exports = (await ext.activate()) as { getAPI(version: number): GitAPI };
  const repo = exports.getAPI(1).repositories[0];
  if (!repo) throw new Error("no git repository open");
  return repo;
}

/** Workspace-relative path for a changed file (repo-root relative, / separators). */
function relPath(repo: GitRepository, uri: vscode.Uri): string {
  const root = repo.rootUri.path.replace(/\/+$/, "");
  return uri.path.startsWith(`${root}/`) ? uri.path.slice(root.length + 1) : uri.path;
}

/** Resolve a repo-relative path to an absolute fsPath, rejecting `..` escapes. */
function absPath(repo: GitRepository, rel: string): string {
  const segments = rel.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) throw new Error("bad path");
  return vscode.Uri.joinPath(repo.rootUri, ...segments).fsPath;
}

/** All changed files (index + working tree + untracked), de-duped, ignored skipped. */
function changedFiles(repo: GitRepository): Array<{ path: string; status: string }> {
  const seen = new Map<string, string>();
  const groups = [repo.state.indexChanges, repo.state.workingTreeChanges, repo.state.untrackedChanges];
  for (const group of groups) {
    for (const change of group) {
      if (change.status === IGNORED) continue;
      const path = relPath(repo, change.uri);
      if (!seen.has(path)) seen.set(path, STATUS_CODE[change.status] ?? "M");
    }
  }
  return [...seen.entries()].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

/** A pseudo-patch for a file git can't diff yet (untracked): whole file as added. */
async function untrackedPatch(repo: GitRepository, rel: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(repo.rootUri, ...rel.split("/")));
  const text = new TextDecoder().decode(bytes);
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

async function execute(args: GitReviewArgs): Promise<GitReviewResult> {
  const repo = await getRepo();
  switch (args.kind) {
    case "git.status": {
      await repo.status(); // refresh so the phone sees the current tree, not a cached one
      return { ok: true, branch: repo.state.HEAD?.name, files: changedFiles(repo) };
    }
    case "git.diff": {
      if (!args.path) {
        // Whole-run diff: concatenate per-file patches (keeps untracked files included).
        await repo.status();
        const parts: string[] = [];
        for (const file of changedFiles(repo)) {
          parts.push(file.status === "U" ? await untrackedPatch(repo, file.path) : await repo.diffWithHEAD(file.path));
        }
        return { ok: true, patch: parts.filter((p) => p.length > 0).join("\n") };
      }
      const abs = absPath(repo, args.path);
      try {
        const patch = await repo.diffWithHEAD(abs);
        if (patch.length > 0) return { ok: true, patch };
      } catch {
        /* fall through to the untracked pseudo-patch */
      }
      return { ok: true, patch: await untrackedPatch(repo, args.path) };
    }
    case "git.commit": {
      if (!args.message) return { ok: false, error: "message is required" };
      await repo.status();
      const targets = args.paths?.length ? args.paths : changedFiles(repo).map((f) => f.path);
      if (!targets.length) return { ok: false, error: "nothing to commit" };
      await repo.add(targets.map((p) => absPath(repo, p)));
      await repo.commit(args.message);
      const sha = await repo.getCommit("HEAD").then((c) => c.hash, () => undefined);
      return { ok: true, sha };
    }
    case "git.revert": {
      if (!args.paths?.length) return { ok: false, error: "paths are required" };
      // clean() discards: checkout for tracked changes, delete for untracked files.
      await repo.clean(args.paths.map((p) => absPath(repo, p)));
      return { ok: true };
    }
  }
}

/** Register the command the workbench relay bridge delegates git.* commands to. */
export function registerGitReview(): vscode.Disposable {
  return vscode.commands.registerCommand("celiador.relayGit", async (args: GitReviewArgs): Promise<GitReviewResult> => {
    try {
      return await execute(args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
