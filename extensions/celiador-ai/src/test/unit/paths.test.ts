import * as assert from "assert";

// Mock vscode.Uri for unit testing
class MockUri {
  constructor(public readonly path: string) {}
  
  static file(path: string): MockUri {
    return new MockUri(path);
  }
  
  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    const parts = base.path.split("/").filter(p => p);
    for (const segment of segments) {
      const segParts = segment.split("/").filter(p => p);
      for (const part of segParts) {
        if (part === "..") {
          parts.pop();
        } else if (part !== ".") {
          parts.push(part);
        }
      }
    }
    return new MockUri("/" + parts.join("/"));
  }
}

function resolveInWorkspace(root: MockUri, p: string): MockUri {
  const rel = String(p ?? "").trim();
  if (!rel) throw new Error("Empty path.");
  if (rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error("Path must be relative to the workspace root.");
  }
  const target = MockUri.joinPath(root, rel);
  const rootPrefix = root.path.endsWith("/") ? root.path : root.path + "/";
  if (target.path !== root.path && !target.path.startsWith(rootPrefix)) {
    throw new Error("Path escapes the workspace root.");
  }
  return target;
}

function isProtectedPath(rel: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(rel) || /(^|\/)node_modules(\/|$)/.test(rel);
}

describe("Path Security Unit Tests", () => {
  describe("resolveInWorkspace", () => {
    it("should reject absolute paths", () => {
      const root = MockUri.file("/workspace");
      
      assert.throws(() => resolveInWorkspace(root, "/etc/passwd"), /Path must be relative/);
      assert.throws(() => resolveInWorkspace(root, "~/secrets"), /Path must be relative/);
      assert.throws(() => resolveInWorkspace(root, "C:\\Windows\\System32"), /Path must be relative/);
    });

    it("should reject parent directory escapes", () => {
      const root = MockUri.file("/workspace");
      
      assert.throws(() => resolveInWorkspace(root, "../../../etc/passwd"), /escapes the workspace root/);
      assert.throws(() => resolveInWorkspace(root, "subdir/../../../../../../etc/passwd"), /escapes the workspace root/);
    });

    it("should allow valid relative paths", () => {
      const root = MockUri.file("/workspace");
      
      const result1 = resolveInWorkspace(root, "file.txt");
      assert.ok(result1.path.startsWith(root.path));
      
      const result2 = resolveInWorkspace(root, "subdir/file.txt");
      assert.ok(result2.path.startsWith(root.path));
    });

    it("should reject empty paths", () => {
      const root = MockUri.file("/workspace");
      
      assert.throws(() => resolveInWorkspace(root, ""), /Empty path/);
      assert.throws(() => resolveInWorkspace(root, "   "), /Empty path/);
    });
  });

  describe("isProtectedPath", () => {
    it("should block .git and node_modules", () => {
      assert.strictEqual(isProtectedPath(".git/config"), true);
      assert.strictEqual(isProtectedPath("subdir/.git/HEAD"), true);
      assert.strictEqual(isProtectedPath("node_modules/package/index.js"), true);
      assert.strictEqual(isProtectedPath("src/node_modules/dep/file.js"), true);
    });

    it("should allow normal paths", () => {
      assert.strictEqual(isProtectedPath("file.txt"), false);
      assert.strictEqual(isProtectedPath("src/index.ts"), false);
      assert.strictEqual(isProtectedPath(".github/workflows/ci.yml"), false);
      assert.strictEqual(isProtectedPath("gitignore.txt"), false);
      assert.strictEqual(isProtectedPath("my_node_modules.txt"), false);
    });
  });
});
