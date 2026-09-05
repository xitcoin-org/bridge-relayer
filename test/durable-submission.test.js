import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SignedIntentJournal } from "../src/signed-intent.js";
import { BroadcastIntentJournal } from "../src/broadcast-intent.js";
import { reserveStoredCronosIntent } from "../src/durable-submission.js";
import { storedCandidate, manifest } from "./fixtures/durable.js";
import { journalOptions } from "./journal-fixture.js";
const failure = { message: "signed intent unavailable or conflicting" };
const integrationFailure = { message: "durable destination reservation unavailable" };
function fixture(run) {
  const dir = mkdtempSync("/tmp/signed-intent-");
  return Promise.resolve().then(() => run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const journal = (dir, config = manifest) => new SignedIntentJournal(`${dir}/signed.sqlite`, config, journalOptions("cronos"));
const intent = (dir, config = manifest) => new BroadcastIntentJournal(`${dir}/intent.sqlite`, config, journalOptions(config.destination));
function raw(dir, sql) { const db = new DatabaseSync(`${dir}/signed.sqlite`); try { db.exec(sql); } finally { db.close(); } }
function child(dir, stage, patch = {}) {
  const base = new URL("../", import.meta.url).href;
  const code = `import { SignedIntentJournal } from '${base}src/signed-intent.js';
    import { BroadcastIntentJournal } from '${base}src/broadcast-intent.js';
    import { reserveStoredCronosIntent } from '${base}src/durable-submission.js';
    import { journalOptions } from '${base}test/journal-fixture.js';
    import { storedCandidate, manifest } from '${base}test/fixtures/durable.js';
    const dir = ${JSON.stringify(dir)};
    const candidate = storedCandidate(':memory:', ${JSON.stringify(patch)});
    const signedJournal = new SignedIntentJournal(dir + '/signed.sqlite', manifest, journalOptions('cronos'));
    const intentJournal = new BroadcastIntentJournal(dir + '/intent.sqlite', manifest, journalOptions('cronos'));
    const stage = ${JSON.stringify(stage)};
    if (stage === 'before-reservation') process.kill(process.pid, 'SIGKILL');
    try {
      const reservation = signedJournal.reserve(candidate.signed);
      if (stage === 'after-custody') process.kill(process.pid, 'SIGKILL');
      const result = reserveStoredCronosIntent({ ...candidate, signedJournal, intentJournal, manifest });
      if (stage === 'before-simulated-send' || stage === 'after-simulated-send') {
        signedJournal.markUncertain(candidate.sourceRef); intentJournal.markUncertain(candidate.sourceRef);
        // Only a local marker simulates a send. There is no broadcaster or network call.
        if (stage === 'after-simulated-send') process.stdout.write('simulated');
        process.kill(process.pid, 'SIGKILL');
      }
      process.stdout.write(JSON.stringify({ ...result, created: reservation.created }));
    } catch { process.stdout.write('rejected'); }
    signedJournal.close(); intentJournal.close(); candidate.store.close();`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    p.stdout.on("data", (b) => { output += b; }); p.stderr.on("data", (b) => { errors += b; });
    p.on("error", reject);
    p.on("close", (status, signal) => status === 0 || signal === "SIGKILL" ? resolve(output) : reject(new Error(errors)));
  });
}
test("verified stored approval maps to exact durable bytes and nonce, with no lifecycle advance", () => fixture((dir) => {
  const candidate = storedCandidate(), signedJournal = journal(dir), intentJournal = intent(dir);
  try {
    const args = { ...candidate, signedJournal, intentJournal, manifest };
    assert.equal(reserveStoredCronosIntent(args).mayBroadcast, false);
    assert.deepEqual(reserveStoredCronosIntent(args), reserveStoredCronosIntent(args));
    const row = signedJournal.inspect(candidate.sourceRef);
    assert.equal(row.signedHex, candidate.signedHex); assert.equal(row.transactionHash, candidate.signed.transactionHash);
    assert.equal(candidate.store.get("xitcoin", candidate.sourceRef).state, "approved");
    assert.equal(signedJournal.inspect(`0x${"ff".repeat(32)}`).mayBroadcast, false);
    assert.throws(() => signedJournal.reserve({ ...candidate.signed }), failure);
    intentJournal.markUncertain(candidate.sourceRef);
    assert.equal(reserveStoredCronosIntent(args).state, "uncertain");
    assert.equal(signedJournal.inspect(candidate.sourceRef).state, "uncertain");
  } finally { signedJournal.close(); intentJournal.close(); candidate.store.close(); }
}));
test("stored recipient, amount, source evidence and digest are revalidated before reservation", () => fixture((dir) => {
  const signedJournal = journal(dir), intentJournal = intent(dir);
  try {
    for (const sql of ["UPDATE transfers SET payload=json_set(payload, '$.amount', '11')",
      "UPDATE transfers SET payload=json_set(payload, '$.destination', '0x1000000000000000000000000000000000000001')",
      "UPDATE transfers SET block_height=11", "UPDATE transfers SET approval_request=json_set(approval_request, '$.digest', 'wrong')",
      "DELETE FROM approvals WHERE signer=(SELECT signer FROM approvals LIMIT 1)",
      "UPDATE approvals SET signature='bad'", "UPDATE transfers SET state='submitted'", "UPDATE transfers SET destination_ref='pending'"]) {
      const candidate = storedCandidate();
      try {
        candidate.store.database.exec(sql);
        assert.throws(() => reserveStoredCronosIntent({ ...candidate, signedJournal, intentJournal, manifest }), integrationFailure);
        assert.equal(signedJournal.inspect(candidate.sourceRef).found, false);
      } finally { candidate.store.close(); }
    }
  } finally { signedJournal.close(); intentJournal.close(); }
}));
test("replacement and account nonce reuse are permanently rejected, including other transfers", () => fixture((dir) => {
  const db = journal(dir), first = storedCandidate(), replacement = storedCandidate(":memory:", { amount: "11" }),
    other = storedCandidate(":memory:", { sourceRef: `0x${"fe".repeat(32)}` });
  try {
    db.reserve(first.signed); db.markUncertain(first.sourceRef);
    for (const signed of [replacement.signed, other.signed]) assert.throws(() => db.reserve(signed), failure);
    assert.equal(db.reserve(first.signed).state, "uncertain");
  } finally { db.close(); first.store.close(); replacement.store.close(); other.store.close(); }
}));
test("competing workers reserve one immutable transaction", () => fixture(async (dir) => {
  journal(dir).close(); intent(dir).close();
  const results = await Promise.all(Array.from({ length: 4 }, () => child(dir, "reserve")));
  assert.equal(results.map(JSON.parse).filter((r) => r.created).length, 1);
  assert(results.map(JSON.parse).every((r) => r.mayBroadcast === false));
}));
test("nonce race between different transfers has exactly one winner", () => fixture(async (dir) => {
  journal(dir).close(); intent(dir).close();
  const results = await Promise.all([child(dir, "reserve"), child(dir, "reserve", { sourceRef: `0x${"fe".repeat(32)}` })]);
  assert.equal(results.filter((r) => r === "rejected").length, 1);
}));
for (const stage of ["before-reservation", "after-custody", "before-simulated-send", "after-simulated-send"]) {
  test(`process crash ${stage} preserves blocking state on restart`, () => fixture(async (dir) => {
    journal(dir).close(); intent(dir).close();
    await child(dir, stage);
    const candidate = storedCandidate(), signedJournal = journal(dir), intentJournal = intent(dir);
    try {
      const before = signedJournal.inspect(candidate.sourceRef);
      assert.equal(before.found, stage !== "before-reservation");
      const result = reserveStoredCronosIntent({ ...candidate, signedJournal, intentJournal, manifest });
      assert.equal(result.mayBroadcast, false);
      assert.equal(result.state, stage.includes("simulated-send") ? "uncertain" : "reserved");
      assert.equal(candidate.store.get("xitcoin", candidate.sourceRef).state, "approved");
    } finally { signedJournal.close(); intentJournal.close(); candidate.store.close(); }
  }));
}
test("release changes and destination mismatches never adopt pending state", () => fixture((dir) => {
  const candidate = storedCandidate(), db = journal(dir); db.reserve(candidate.signed); db.close();
  try {
    assert.throws(() => journal(dir, { ...manifest, releaseCommit: "b".repeat(40) }), failure);
    assert.throws(() => journal(dir, { ...manifest, destination: "xitcoin" }), failure);
    const signedJournal = journal(dir), intentJournal = intent(dir, { ...manifest, destination: "xitcoin" });
    try { assert.throws(() => reserveStoredCronosIntent({ ...candidate, signedJournal, intentJournal, manifest }), integrationFailure); }
    finally { signedJournal.close(); intentJournal.close(); }
  } finally { candidate.store.close(); }
}));
for (const sql of ["DROP TABLE signed_intents", "PRAGMA user_version=2", "DELETE FROM intent_binding",
  "UPDATE intent_binding SET binding='{}'", "CREATE INDEX unwanted ON signed_intents(state)"]) {
  test(`incompatible custody journal is rejected: ${sql}`, () => fixture((dir) => {
    journal(dir).close(); raw(dir, sql); assert.throws(() => journal(dir), failure);
  }));
}
test("damaged signed byte hash is detected on read", () => fixture((dir) => {
  const candidate = storedCandidate(), db = journal(dir); db.reserve(candidate.signed); db.close();
  raw(dir, "UPDATE signed_intents SET transaction_hash='0x' || replace(hex(zeroblob(32)), '0', 'a')");
  const reopened = journal(dir);
  try { assert.throws(() => reopened.inspect(candidate.sourceRef), failure); }
  finally { reopened.close(); candidate.store.close(); }
}));
test("custody filesystem rejects symlinks and permissive paths and preserves private modes", () => fixture((dir) => {
  writeFileSync(`${dir}/target`, "", { mode: 0o600 }); symlinkSync(`${dir}/target`, `${dir}/signed.sqlite`);
  assert.throws(() => journal(dir), failure); rmSync(`${dir}/signed.sqlite`);
  chmodSync(dir, 0o777); assert.throws(() => journal(dir), failure); chmodSync(dir, 0o700);
  const candidate = storedCandidate(), db = journal(dir);
  try { db.reserve(candidate.signed); for (const suffix of ["", "-wal", "-shm"]) assert.equal(statSync(`${dir}/signed.sqlite${suffix}`).mode & 0o777, 0o600); }
  finally { db.close(); candidate.store.close(); }
}));
