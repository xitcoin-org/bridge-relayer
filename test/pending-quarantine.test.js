import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SignedIntentJournal } from "../src/signed-intent.js";
import { BroadcastIntentJournal } from "../src/broadcast-intent.js";
import { quarantineCronosPending } from "../src/pending-quarantine.js";
import { storedCandidate, manifest } from "./fixtures/durable.js";
import { journalOptions } from "./journal-fixture.js";

const failure = { message: "pending custody quarantine unavailable" };
function fixture(run) {
  const dir = mkdtempSync("/tmp/pending-quarantine-");
  const candidate = storedCandidate();
  const signedJournal = new SignedIntentJournal(`${dir}/signed.sqlite`, manifest, journalOptions("cronos"));
  const intentJournal = new BroadcastIntentJournal(`${dir}/intent.sqlite`, manifest, journalOptions("cronos"));
  const args = { signedJournal, intentJournal, manifest, transferId: candidate.sourceRef };
  try { run({ dir, candidate, args }); }
  finally { signedJournal.close(); intentJournal.close(); candidate.store.close(); rmSync(dir, { recursive: true, force: true }); }
}
function intentRow(dir) {
  const db = new DatabaseSync(`${dir}/intent.sqlite`, { readOnly: true });
  try { return db.prepare("SELECT * FROM broadcast_intents").get(); }
  finally { db.close(); }
}

test("custody-only restart recovery permanently blocks both journals without approval renewal", () => fixture(({ dir, candidate, args }) => {
  args.signedJournal.reserve(candidate.signed);
  // No current timestamp, approval, signer, endpoint or chain result is accepted.
  // Recovery can therefore quarantine bytes even after the original deadline.
  const result = quarantineCronosPending(args);
  assert.equal(result.state, "uncertain");
  assert.equal(result.mayBroadcast, false); assert.equal(result.mayRetry, false); assert.equal(result.finalized, false);
  assert.equal(args.signedJournal.inspect(candidate.sourceRef).signedHex, candidate.signedHex);
  assert.equal(args.signedJournal.inspect(candidate.sourceRef).state, "uncertain");
  assert.equal(intentRow(dir).state, "uncertain");
  assert.deepEqual(quarantineCronosPending(args), result);
  assert.equal(candidate.store.get("xitcoin", candidate.sourceRef).state, "approved");
  assert.equal(candidate.store.get("xitcoin", candidate.sourceRef).destination_ref, null);
}));

test("digest conflict retains first committed uncertainty and never overwrites the conflicting intent", () => fixture(({ dir, candidate, args }) => {
  args.signedJournal.reserve(candidate.signed);
  const conflicting = `0x${"fa".repeat(32)}`;
  args.intentJournal.reserve({ transferId: candidate.sourceRef, approvalDigest: candidate.signed.approvalDigest,
    transactionDigest: conflicting });
  assert.throws(() => quarantineCronosPending(args), failure);
  assert.equal(args.signedJournal.inspect(candidate.sourceRef).state, "uncertain");
  assert.equal(intentRow(dir).transaction_digest, conflicting);
  assert.throws(() => quarantineCronosPending(args), failure);
}));

test("second journal failure leaves restart-readable uncertainty in custody", () => fixture(({ dir, candidate, args }) => {
  args.signedJournal.reserve(candidate.signed);
  const blocker = new DatabaseSync(`${dir}/intent.sqlite`);
  blocker.exec("BEGIN IMMEDIATE");
  try { assert.throws(() => quarantineCronosPending(args), failure); }
  finally { blocker.exec("ROLLBACK"); blocker.close(); }
  const reopened = new SignedIntentJournal(`${dir}/signed.sqlite`, manifest, journalOptions("cronos"));
  try { assert.equal(reopened.inspect(candidate.sourceRef).state, "uncertain"); }
  finally { reopened.close(); }
  assert.equal(quarantineCronosPending(args).state, "uncertain");
  assert.equal(intentRow(dir).state, "uncertain");
}));

test("missing custody, manifest changes and malformed input cannot authorize or manufacture recovery", () => fixture(({ candidate, args }) => {
  assert.throws(() => quarantineCronosPending(args), failure);
  assert.equal(args.signedJournal.inspect(candidate.sourceRef).found, false);
  args.signedJournal.reserve(candidate.signed);
  for (const patch of [{ releaseCommit: "b".repeat(40) }, { destination: "xitcoin" }, { mode: "enabled" }]) {
    assert.throws(() => quarantineCronosPending({ ...args, manifest: { ...manifest, ...patch } }), failure);
  }
  assert.equal(args.signedJournal.inspect(candidate.sourceRef).state, "reserved");
  for (const value of [null, {}, { ...args, nowUnix: 1 }, { ...args, transferId: "invalid" },
    { get signedJournal() { throw new Error("sensitive input"); } }]) {
    assert.throws(() => quarantineCronosPending(value), failure);
  }
}));

test("corrupt signed metadata is rejected before reconstructing a digest entry", () => fixture(({ dir, candidate, args }) => {
  args.signedJournal.reserve(candidate.signed);
  const db = new DatabaseSync(`${dir}/signed.sqlite`);
  try { db.exec("UPDATE signed_intents SET approval_digest='0x' || replace(hex(zeroblob(32)), '0', 'f')"); }
  finally { db.close(); }
  assert.throws(() => quarantineCronosPending(args), failure);
  assert.equal(intentRow(dir), undefined);
}));
