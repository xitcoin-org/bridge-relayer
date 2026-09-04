import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const units = [
  "xitcoin-bridge-signer@.service",
  "xitcoin-bridge-coordinator.service",
  "xitcoin-bridge-submitter@.service",
];

test("runs every Node runtime without JIT under executable-memory denial", async () => {
  for (const unit of units) {
    const body = await readFile(new URL(`../ops/systemd/${unit}`, import.meta.url), "utf8");
    assert.match(body, /^MemoryDenyWriteExecute=true$/m);
    const command = body.match(/^ExecStart=(.+)$/m)?.[1] ?? "";
    assert.match(command, /^\/opt\/xitcoin-bridge-node\/24\.19\.0\/bin\/node --jitless /);
    assert.doesNotMatch(command, /\/usr\/bin\/env node/);
  }
});
