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

  it("should register the contributed webview view", () => {
    const packageJsonPath = path.join(__dirname, "../../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const extensionPath = path.join(__dirname, "../../extension.js");
    const extensionContent = fs.readFileSync(extensionPath, "utf-8");

    // Get webview views from package.json
    const views = packageJson.contributes?.views || {};
    const allViews: string[] = [];
    
    for (const container of Object.values(views)) {
      if (Array.isArray(container)) {
        allViews.push(...container.map((v: any) => v.id));
      }
    }

    // Verify each view is registered
    for (const viewId of allViews) {
      const registerPattern = new RegExp(`registerWebviewViewProvider\\(["']${viewId.replace(/\./g, "\\.")}["']`);
      
      assert.ok(
        registerPattern.test(extensionContent),
        `Webview view '${viewId}' from package.json must be registered in activate().`
      );
    }
  });

  it("should register the contributed language model chat provider", () => {
    const packageJsonPath = path.join(__dirname, "../../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const extensionPath = path.join(__dirname, "../../extension.js");
    const extensionContent = fs.readFileSync(extensionPath, "utf-8");

    // Get language model providers from package.json
    const providers = packageJson.contributes?.languageModelChatProviders || [];
    
    for (const provider of providers) {
      const vendor = provider.vendor;
      
      assert.ok(
        extensionContent.includes("registerLanguageModelChatProvider"),
        `Language model chat provider '${vendor}' from package.json must be registered in activate().`
      );
    }
  });
});
