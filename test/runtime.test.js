import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeHealth, RuntimeSupervisor, createHealthHttpHandler, validateRuntimeTopology } from "../src/runtime.js";

test("requires separated runtime identities and independent HTTPS RPC origins", () => {
  const topology = validateRuntimeTopology({ coordinatorIdentity: "coordinator", signerIdentities: ["signer-1", "signer-2", "signer-3"], submitterIdentities: ["submitter-xitcoin", "submitter-cronos"], cronosRpcUrls: ["https://cronos-a.example/rpc", "https://cronos-b.example/rpc"], xitcoinRpcUrls: ["https://xitcoin-a.example/rpc", "https://xitcoin-b.example/rpc"] });
  assert.equal(topology.signerIdentities.length, 3);
  assert.equal(topology.cronosRpcOrigins.length, 2);
  assert.throws(() => validateRuntimeTopology({ coordinatorIdentity: "signer-1", signerIdentities: ["signer-1", "signer-2", "signer-3"], submitterIdentities: ["submitter-a", "submitter-b"], cronosRpcUrls: ["https://a.example", "https://b.example"], xitcoinRpcUrls: ["https://c.example", "https://d.example"] }), /separated/);
  assert.throws(() => validateRuntimeTopology({ coordinatorIdentity: "coordinator", signerIdentities: ["one", "two", "three"], submitterIdentities: ["four", "five"], cronosRpcUrls: ["https://same.example/a", "https://same.example/b"], xitcoinRpcUrls: ["https://c.example", "https://d.example"] }), /independent/);
  assert.throws(() => validateRuntimeTopology({ coordinatorIdentity: "coordinator", signerIdentities: ["one", "two", "three"], submitterIdentities: ["four", "five"], cronosRpcUrls: ["https://user:secret@a.example", "https://b.example"], xitcoinRpcUrls: ["https://c.example", "https://d.example"] }), /credentials/);
});

test("supervisor reports readiness only after every worker succeeds", async () => {
  let now = 1000;
  const health = new RuntimeHealth({ workers: ["watchers", "approvals", "submissions"], staleAfterSeconds: 30, now: () => now });
  const calls = [];
  const supervisor = new RuntimeSupervisor({ health, workers: ["watchers", "approvals", "submissions"].map((name) => ({ name, async run() { calls.push(name); } })) });
  assert.equal(health.snapshot().ready, false);
  const snapshot = await supervisor.runCycle();
  assert.equal(snapshot.ready, true);
  assert.deepEqual(calls, ["watchers", "approvals", "submissions"]);
  now = 1031;
  assert.equal(health.snapshot().ready, false);
});

test("critical worker failure halts processing without exposing its error", async () => {
  const health = new RuntimeHealth({ workers: ["watchers", "submissions"], now: () => 1000 });
  const supervisor = new RuntimeSupervisor({ health, workers: [
    { name: "watchers", async run() { throw new Error("secret RPC response"); } },
    { name: "submissions", async run() {} },
  ] });
  await assert.rejects(() => supervisor.runCycle(), /critical runtime worker failed: watchers/);
  assert.equal(supervisor.halted, true);
  assert.equal(JSON.stringify(health.snapshot()).includes("secret RPC response"), false);
  await assert.rejects(() => supervisor.runCycle(), /halted/);
});

function responseCapture() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(body = "") { this.body += body; } };
}

test("health handler exposes bounded liveness and readiness without caching", async () => {
  const health = new RuntimeHealth({ workers: ["watchers"], now: () => 1000 });
  const handler = createHealthHttpHandler({ health });
  const live = responseCapture();
  handler({ method: "GET", url: "/livez" }, live);
  assert.equal(live.status, 200);
  assert.equal(live.headers["cache-control"], "no-store");
  const notReady = responseCapture();
  handler({ method: "GET", url: "/readyz" }, notReady);
  assert.equal(notReady.status, 503);
  health.running("watchers");
  health.succeeded("watchers");
  const ready = responseCapture();
  handler({ method: "GET", url: "/readyz" }, ready);
  assert.equal(ready.status, 200);
  assert.equal(JSON.parse(ready.body).ready, true);
});
