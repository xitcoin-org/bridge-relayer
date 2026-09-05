import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { journalOptions } from "./journal-fixture.js";
import { BroadcastIntentJournal } from "../src/broadcast-intent.js";
import { inspectXitcoinReplayStatus } from "../src/destination-status.js";

const config = (destination = "xitcoin") => ({ version: 1, mode: "disabled", destination,
  releaseCommit: "a".repeat(40), routeId: "cronos-testnet-xitcoin-testnet",
  cronosChainId: 338, xitcoinChainId: "xitcoin-testnet-v2-1" });
const hash = (letter) => `0x${letter.repeat(64)}`;
const intent = { transferId: hash("a"), approvalDigest: hash("b"), transactionDigest: hash("c") };
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "intent-test-"));
  try { await run(join(directory, "intent.sqlite")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function child(path, manifest, abrupt = false) {
  const code = `import { BroadcastIntentJournal } from ${JSON.stringify(new URL("../src/broadcast-intent.js", import.meta.url).href)};
    const { journalOptions } = await import(${JSON.stringify(new URL("./journal-fixture.js", import.meta.url).href)});
    const store = new BroadcastIntentJournal(${JSON.stringify(path)}, ${JSON.stringify(manifest)}, journalOptions(${JSON.stringify(manifest.destination)}));
    const result = store.reserve(${JSON.stringify(intent)});
    process.stdout.write(JSON.stringify(result), () => { ${abrupt ? "process.kill(process.pid, 'SIGKILL')" : "store.close()"}; });`;
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    process.stdout.on("data", (data) => { output += data; });
    process.stderr.on("data", (data) => { errors += data; });
    process.on("error", reject);
    process.on("close", (exit, signal) => {
      if (exit !== 0 && !(abrupt && signal === "SIGKILL")) return reject(new Error(errors));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}
for (const destination of ["xitcoin", "cronos"]) {
  test(`${destination}: durable reservations block repeat and conflicting transaction identities`, () => fixture(async (path) => {
    let store = new BroadcastIntentJournal(path, config(destination), journalOptions(destination));
    assert.deepEqual(store.reserve(intent), { created: true, state: "reserved", mayBroadcast: false });
    assert.equal(store.reserve(intent).created, false);
    for (const patch of [{ approvalDigest: hash("d") }, { transactionDigest: hash("e") }, { transferId: hash("f") }]) {
      assert.throws(() => store.reserve({ ...intent, ...patch }), { message: "broadcast intent unavailable or conflicting" });
    }
    store.close();
    store = new BroadcastIntentJournal(path, config(destination), journalOptions(destination));
    assert.equal(store.reserve(intent).created, false);
    assert.deepEqual(store.markUncertain(intent.transferId), { state: "uncertain", mayBroadcast: false });
    store.close();
    store = new BroadcastIntentJournal(path, config(destination), journalOptions(destination));
    assert.deepEqual(store.reserve(intent), { created: false, state: "uncertain", mayBroadcast: false });
    assert.equal(store.markUncertain(intent.transferId).mayBroadcast, false);
    assert.throws(() => store.markUncertain(hash("d")));
    store.close();
  }));
  test(`${destination}: competing processes get one durable reservation and no send permission`, () => fixture(async (path) => {
    new BroadcastIntentJournal(path, config(destination), journalOptions(destination)).close();
    const results = await Promise.all(Array.from({ length: 4 }, () => child(path, config(destination))));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.ok(results.every((r) => r.mayBroadcast === false));
  }));
  test(`${destination}: abrupt exit after commit never permits replacement on recovery`, () => fixture(async (path) => {
    assert.equal((await child(path, config(destination), true)).created, true);
    const store = new BroadcastIntentJournal(path, config(destination), journalOptions(destination));
    assert.deepEqual(store.reserve(intent), { created: false, state: "reserved", mayBroadcast: false });
    assert.throws(() => store.reserve({ ...intent, transactionDigest: hash("d") }));
    store.close();
  }));
}
test("journal rejects changed release or destination binding and invalid identities", () => fixture(async (path) => {
  const store = new BroadcastIntentJournal(path, config(), journalOptions());
  for (const input of [null, undefined, [], {}, { ...intent, extra: true }]) assert.throws(() => store.reserve(input), { message: "broadcast intent unavailable or conflicting" });
  for (const field of Object.keys(intent)) for (const value of [null, "main", hash("A"), "0x01", 1]) {
    assert.throws(() => store.reserve({ ...intent, [field]: value }));
  }
  store.reserve(intent); store.close();
  for (const patch of [{ releaseCommit: "b".repeat(40) }, { destination: "cronos" }, { cronosChainId: 25 }, { mode: "live" }]) {
    assert.throws(() => new BroadcastIntentJournal(path, { ...config(), ...patch }, journalOptions(patch.destination ?? "xitcoin")));
  }
  const reopened = new BroadcastIntentJournal(path, config(), journalOptions());
  assert.equal(reopened.reserve(intent).created, false); reopened.close();
}));
test("replay status never proves completion or safe retry", () => {
  const id = "a".repeat(64);
  for (const processed of [true, false]) {
    assert.deepEqual(inspectXitcoinReplayStatus(id, { attestation_id: id, processed }), {
      processed, finalized: false, mayBroadcast: false, blocker: "canonical_transaction_and_finality_evidence_missing",
    });
  }
  for (const response of [null, {}, { attestation_id: id }, { attestation_id: id, processed: "false" },
    { attestation_id: "b".repeat(64), processed: true }, { attestation_id: id, processed: true, transaction: "untrusted" }]) {
    assert.throws(() => inspectXitcoinReplayStatus(id, response), { message: "invalid Xitcoin replay status" });
  }
});

test("replay parser rejects accessors, prototypes and unbounded shapes without leaking errors", () => {
  const id = "a".repeat(64);
  let accessed = false;
  const accessor = { attestation_id: id, get processed() { accessed = true; throw new Error("secret"); } };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const deep = {}; let tail = deep;
  for (let i = 0; i < 10000; i++) tail = tail.next = {};
  for (const response of [accessor, revoked.proxy, new Proxy({}, { ownKeys() { throw new Error("secret"); } }),
    Object.create(null), Object.create({ attestation_id: id, processed: false }), new Date(), [],
    { attestation_id: id, processed: deep }, { attestation_id: "a".repeat(1000000), processed: false },
    { attestation_id: id, processed: false, ...Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [i, 0])) },
    { attestation_id: id, processed: false, [Symbol("hidden")]: true }]) {
    assert.throws(() => inspectXitcoinReplayStatus(id, response), { message: "invalid Xitcoin replay status" });
  }
  assert.equal(accessed, false);
});
