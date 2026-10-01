import * as assert from "assert";
import * as vscode from "vscode";

suite("Celiador AI Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  suite("Path Security", () => {
    test("resolveInWorkspace should reject absolute paths", async () => {
      const root = vscode.Uri.file("/workspace");
      
      const testCases = [
        "/etc/passwd",
        "/tmp/malicious",
        "~/secrets",
        "C:\\Windows\\System32",
      ];

      for (const badPath of testCases) {
        assert.throws(
          () => resolveInWorkspace(root, badPath),
          /Path must be relative/,
          `Should reject absolute path: ${badPath}`
        );
      }
    });

    test("resolveInWorkspace should reject parent directory escapes", async () => {
      const root = vscode.Uri.file("/workspace");
      
      const testCases = [
        "../../../etc/passwd",
        "subdir/../../../../../../etc/passwd",
        "valid/../../../outside",
      ];

      for (const badPath of testCases) {
        assert.throws(
          () => resolveInWorkspace(root, badPath),
          /escapes the workspace root/,
          `Should reject escape path: ${badPath}`
        );
      }
    });

    test("resolveInWorkspace should allow valid relative paths", async () => {
      const root = vscode.Uri.file("/workspace");
      
      const testCases = [
        "file.txt",
        "subdir/file.txt",
        "deep/nested/path/file.txt",
        "src/../lib/file.txt",
      ];

      for (const goodPath of testCases) {
        const result = resolveInWorkspace(root, goodPath);
        assert.ok(result.path.startsWith(root.path + "/") || result.path === root.path);
      }
    });

    test("resolveInWorkspace should reject empty paths", async () => {
      const root = vscode.Uri.file("/workspace");
      
      assert.throws(
        () => resolveInWorkspace(root, ""),
        /Empty path/
      );
      
      assert.throws(
        () => resolveInWorkspace(root, "   "),
        /Empty path/
      );
    });

    test("isProtectedPath should block .git and node_modules", async () => {
      const protectedPaths = [
        ".git/config",
        "subdir/.git/HEAD",
        "node_modules/package/index.js",
        "src/node_modules/dep/file.js",
        ".git",
        "node_modules",
      ];

      for (const path of protectedPaths) {
        assert.ok(isProtectedPath(path), `Should protect: ${path}`);
      }
    });

    test("isProtectedPath should allow normal paths", async () => {
      const normalPaths = [
        "file.txt",
        "src/index.ts",
        ".github/workflows/ci.yml",
        "gitignore.txt",
        "my_node_modules.txt",
      ];

      for (const path of normalPaths) {
        assert.ok(!isProtectedPath(path), `Should allow: ${path}`);
      }
    });
  });

  suite("Settings Security", () => {
    test("restricted settings should not read workspace values", async () => {
      const restrictedSettings = [
        "daemonUrl",
        "supabaseUrl",
        "token",
        "apiKey",
        "provider",
        "autoApproveEdits",
      ];

      for (const setting of restrictedSettings) {
        const cfg = vscode.workspace.getConfiguration("celiador");
        const inspection = cfg.inspect(setting);
        
        if (inspection?.workspaceValue !== undefined) {
          const restricted = getRestrictedSettingValue(setting);
          assert.notStrictEqual(
            restricted,
            inspection.workspaceValue,
            `Setting ${setting} should not use workspace value`
          );
        }
      }
    });

    test("non-restricted settings should work normally", async () => {
      const cfg = vscode.workspace.getConfiguration("celiador");
      
      const model = cfg.get<string>("model");
      const effort = cfg.get<string>("effort");
      
      assert.ok(model !== undefined);
      assert.ok(effort !== undefined);
    });
  });

  suite("Stream Parser", () => {
    test("should parse SSE data events", () => {
      const lines = [
        "data: {\"type\":\"content_block_start\",\"index\":0}",
        "data: {\"type\":\"content_block_delta\",\"index\":0}",
        "data: [DONE]",
      ];

      const events: any[] = [];
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          continue;
        }
      }

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].type, "content_block_start");
      assert.strictEqual(events[1].type, "content_block_delta");
    });

    test("should handle incomplete buffer correctly", () => {
      let buf = "data: {\"type\":\"start\"}\ndata: {\"ty";
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(buf, "data: {\"ty");
    });

    test("should skip non-data lines", () => {
      const lines = [
        ": comment",
        "event: ping",
        "data: {\"type\":\"valid\"}",
      ];

      const events: any[] = [];
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        events.push(JSON.parse(payload));
      }

      assert.strictEqual(events.length, 1);
    });
  });
});

function resolveInWorkspace(root: vscode.Uri, p: string): vscode.Uri {
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

function isProtectedPath(rel: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(rel) || /(^|\/)node_modules(\/|$)/.test(rel);
}

function getRestrictedSettingValue<T>(key: string): T | undefined {
  const cfg = vscode.workspace.getConfiguration("celiador");
  const inspection = cfg.inspect<T>(key);
  if (!inspection) return undefined;
  return inspection.applicationValue ?? inspection.globalValue ?? inspection.defaultValue;
}
