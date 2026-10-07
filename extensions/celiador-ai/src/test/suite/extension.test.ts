import * as assert from "assert";
import * as vscode from "vscode";
import { getRestrictedSetting } from "../../config";

suite("Celiador AI Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  suite("Settings Security", () => {
    test("restricted settings use globalValue not workspaceValue", async () => {
      const cfg = vscode.workspace.getConfiguration("celiador");
      const inspection = cfg.inspect<string>("daemonUrl");

      if (inspection) {
        const result = getRestrictedSetting("daemonUrl", "https://celiador.ai");
        assert.ok(result === (inspection.globalValue ?? inspection.defaultValue ?? "https://celiador.ai"));
      }
    });

    test("only the restricted connection settings are contributed", async () => {
      const ext = vscode.extensions.all.find((e) => e.id === "celiador.celiador-ai");
      assert.ok(ext, "celiador-ai extension must be installed");
      const props = Object.keys(ext.packageJSON.contributes?.configuration?.properties ?? {}).sort();
      assert.deepStrictEqual(props, ["celiador.daemonUrl", "celiador.supabaseUrl"]);
    });
  });
});
