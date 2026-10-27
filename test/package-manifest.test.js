/**
 * qfg-goi1.2.6 item 9: package.json must not point at things that do not exist.
 *
 * `"module": "dist/index.mjs"` named a file that is never built or published,
 * so bundlers that read `module` and ignore `exports` (webpack 4, older Rollup
 * configs) failed to resolve the package. The `lint` script ran eslint, which
 * is not a devDependency (CI gates on tsc --strict and prettier instead).
 * Runs after `npm run build` (the `npm test` script builds first).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = require("../package.json");

const exportTargets = (node) =>
  typeof node === "string" ? [node] : Object.values(node || {}).flatMap(exportTargets);

// Commands provided by the shell / Node / npm rather than node_modules/.bin.
const SYSTEM_COMMANDS = new Set(["rm", "echo", "node", "npm", "git"]);

describe("package.json", () => {
  test("every entry point exists in the built package", () => {
    const entries = [pkg.main, pkg.module, pkg.types, ...exportTargets(pkg.exports)].filter(
      (e) => e !== undefined
    );
    const missing = entries.filter((e) => !fs.existsSync(path.join(ROOT, e)));
    expect(missing).toEqual([]);
  });

  test("every script runs a command that is installed", () => {
    const missing = [];
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const segment of script.split(/&&|\|\|/)) {
        const command = segment.trim().split(/\s+/)[0];
        if (!command || SYSTEM_COMMANDS.has(command) || command.startsWith("'")) continue;
        if (!fs.existsSync(path.join(ROOT, "node_modules", ".bin", command))) {
          missing.push(`${name}: ${command}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // qfg-66ko.6: uuid < 11.1.1 carries GHSA-w5hq-g745-h8pq (v3/v5/v6 buffer bounds). uuid 11 ships
  // its own types, so @types/uuid must go too (it would shadow them with the v9 signatures).
  test("depends on a uuid with the GHSA-w5hq-g745-h8pq fix and no @types/uuid", () => {
    const [major, minor, patch] = require("uuid/package.json").version.split(".").map(Number);
    expect(major > 11 || (major === 11 && (minor > 1 || (minor === 1 && patch >= 1)))).toBe(true);
    expect(pkg.dependencies.uuid).toBe("^11.1.1");
    expect(pkg.devDependencies["@types/uuid"]).toBeUndefined();
  });
});
