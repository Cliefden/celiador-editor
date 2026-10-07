import Mocha from "mocha";
import * as path from "path";
import { glob } from "glob";

async function main() {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
  });

  const testsRoot = __dirname;
  const files = await glob("**/*.test.js", { cwd: testsRoot });

  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}

main()
  .then(() => {
    console.log("\nAll unit tests passed!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nUnit tests failed:", err.message);
    process.exit(1);
  });
