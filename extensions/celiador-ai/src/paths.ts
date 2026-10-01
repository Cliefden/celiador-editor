import * as vscode from "vscode";

/** Resolve a caller-supplied path, guaranteeing it stays inside the workspace. */
export function resolveInWorkspace(root: vscode.Uri, p: string): vscode.Uri {
  const rel = String(p ?? "").trim();
  if (!rel) throw new Error("Empty path.");
  if (rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error("Path must be relative to the workspace root.");
  }
  const target = vscode.Uri.joinPath(root, rel);
  const rootPrefix = root.path.endsWith("/") ? root.path : root.path + "/";
  if (target.path !== root.path && !target.path.startsWith(rootPrefix)) {
    throw new Error("Path escapes the workspace root.");
  }
  return target;
}

export function isProtectedPath(rel: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(rel) || /(^|\/)node_modules(\/|$)/.test(rel);
}
