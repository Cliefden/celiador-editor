import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";

describe("Extension Activation", () => {
  it("should export activate function", () => {
    const extensionPath = path.join(__dirname, "../../extension.js");
    const content = fs.readFileSync(extensionPath, "utf-8");

    assert.ok(
      content.includes("exports.activate = activate") || content.includes('exports.activate'),
      "activate function must be exported from extension.js"
    );
  });

  it("should export deactivate function", () => {
    const extensionPath = path.join(__dirname, "../../extension.js");
    const content = fs.readFileSync(extensionPath, "utf-8");

    assert.ok(
      content.includes("exports.deactivate = deactivate") || content.includes('exports.deactivate'),
      "deactivate function must be exported from extension.js"
    );
  });

  it("should register all contributed commands from package.json", () => {
    const packageJsonPath = path.join(__dirname, "../../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const extensionPath = path.join(__dirname, "../../extension.js");
    const extensionContent = fs.readFileSync(extensionPath, "utf-8");

    // Get all command IDs from package.json
    const contributedCommands: string[] = (packageJson.contributes?.commands || []).map(
      (cmd: any) => cmd.command
    );

    // Verify each command is registered in the activate function
    for (const commandId of contributedCommands) {
      const registerPattern = new RegExp(`registerCommand\\(["']${commandId.replace(/\./g, "\\.")}["']`);
      
      assert.ok(
        registerPattern.test(extensionContent),
        `Command '${commandId}' from package.json must be registered in activate(). ` +
        `All contributed commands must be registered.`
      );
    }
  });

  it("should register every contributed webview view", () => {
    const packageJsonPath = path.join(__dirname, "../../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const outDir = path.join(__dirname, "../..");
    const extensionContent = fs.readFileSync(path.join(outDir, "extension.js"), "utf-8");

    // Views are registered via each provider's static `viewId`, so look for the
    // id across the compiled sources and for one registration call per view.
    const sources = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(path.join(outDir, f), "utf-8"))
      .join("\n");

    const views = packageJson.contributes?.views || {};
    const allViews: string[] = [];
    for (const container of Object.values(views)) {
      if (Array.isArray(container)) {
        allViews.push(...container.map((v: any) => v.id));
      }
    }

    for (const viewId of allViews) {
      assert.ok(
        sources.includes(`"${viewId}"`),
        `Webview view '${viewId}' from package.json must have a provider with that viewId.`
      );
    }

    const registrations = extensionContent.match(/registerWebviewViewProvider\(/g) || [];
    assert.strictEqual(
      registrations.length,
      allViews.length,
      "activate() must register one webview view provider per contributed view."
    );
  });
});
