import * as assert from "assert";
import * as vscode from "vscode";
import { resolveInWorkspace, isProtectedPath } from "../../paths";
import { getRestrictedSetting } from "../../config";
import { parseSSELine, splitSSEBuffer } from "../../sse";

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
    test("restricted settings use globalValue not workspaceValue", async () => {
      const cfg = vscode.workspace.getConfiguration("celiador");
      const inspection = cfg.inspect<string>("daemonUrl");
      
      if (inspection) {
        const result = getRestrictedSetting("daemonUrl", "https://celiador.ai");
        assert.ok(result === (inspection.globalValue ?? inspection.defaultValue ?? "https://celiador.ai"));
      }
    });

    test("non-restricted settings work normally", async () => {
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
        const event = parseSSELine(line);
        if (event) events.push(event);
      }

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].type, "content_block_start");
      assert.strictEqual(events[1].type, "content_block_delta");
    });

    test("should handle incomplete buffer correctly", () => {
      const buf = "data: {\"type\":\"start\"}\ndata: {\"ty";
      const { lines, remaining } = splitSSEBuffer(buf);
      
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(remaining, "data: {\"ty");
    });

    test("should skip non-data lines", () => {
      const lines = [
        ": comment",
        "event: ping",
        "data: {\"type\":\"valid\"}",
      ];

      const events: any[] = [];
      for (const line of lines) {
        const event = parseSSELine(line);
        if (event) events.push(event);
      }

      assert.strictEqual(events.length, 1);
    });
  });
});
