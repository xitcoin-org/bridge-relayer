import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "syntax-coverage-"));
  for (const dir of ["src", "test/fixtures", "scripts"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "src/first.js"), "export const valid = true;\n");
  copyFileSync(new URL("../scripts/check-syntax.mjs", import.meta.url), join(root, "scripts/check-syntax.mjs"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const check = (root) => spawnSync(process.execPath, [join(root, "scripts/check-syntax.mjs")], { encoding: "utf8" });

test("syntax check rejects a later source file that Node's multi-path invocation silently skips", () => fixture((root) => {
  writeFileSync(join(root, "src/last.js"), "export const = ;\n");
  const old = spawnSync(process.execPath, ["--check", join(root, "src/first.js"), join(root, "src/last.js")]);
  assert.equal(old.status, 0);
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/last\.js/);
}));

test("syntax check covers nested fixtures and module extensions", () => fixture((root) => {
  for (const name of ["test/fixtures/bad.mjs", "test/fixtures/bad.cjs", "scripts/bad.js"]) {
    writeFileSync(join(root, name), "const = ;\n");
    const result = check(root);
    assert.equal(result.status, 1);
    assert(result.stderr.includes(name));
    rmSync(join(root, name));
  }
}));

test("syntax check parses without executing sources", () => fixture((root) => {
  writeFileSync(join(root, "test/fixtures/valid.js"), "throw new Error('must not execute');\n");
  const result = check(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Syntax checked 3 JavaScript files/);
}));
