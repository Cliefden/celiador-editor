import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// Per-channel defaults come from the build's product.json (dev/staging/prod
// builds ship different values), while the `celiador.daemonUrl` setting lets an
// individual user override without a rebuild. Reading product.json keeps the
// dev/staging/prod split in one place — the build identity — instead of scattered
// hardcoded URLs. See daemon/ENVIRONMENTS.md.

const FALLBACK_DAEMON_URL = "https://celiador.ai";

let productCache: { celiadorDaemonUrl?: string } | null | undefined;

/** Read the fork's product.json once (extension host runs in Node). */
function product(): { celiadorDaemonUrl?: string } {
  if (productCache !== undefined) return productCache ?? {};
  try {
    const file = path.join(vscode.env.appRoot, "product.json");
    productCache = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    productCache = null;
  }
  return productCache ?? {};
}

/**
 * Resolve the daemon base URL for this build.
 * Order: explicit `celiador.daemonUrl` setting → product.json `celiadorDaemonUrl`
 * → hardcoded prod fallback. Trailing slashes are stripped.
 */
export function resolveDaemonUrl(): string {
  const setting = vscode.workspace.getConfiguration("celiador").get<string>("daemonUrl");
  const url = setting || product().celiadorDaemonUrl || FALLBACK_DAEMON_URL;
  return url.replace(/\/+$/, "");
}
