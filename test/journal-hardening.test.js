import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, chmodSync, mkdirSync, symlinkSync, writeFileSync, statSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { BroadcastIntentJournal } from "../src/broadcast-intent.js";
import { journalOptions } from "./journal-fixture.js";

const config = { version: 1, mode: "disabled", destination: "xitcoin", releaseCommit: "a".repeat(40),
  routeId: "cronos-testnet-xitcoin-testnet", cronosChainId: 338, xitcoinChainId: "xitcoin-testnet-v2-1" };
const intent = { transferId: `0x${"a".repeat(64)}`, approvalDigest: `0x${"b".repeat(64)}`, transactionDigest: `0x${"c".repeat(64)}` };
const failure = { message: "broadcast intent unavailable or conflicting" };
function fixture(run) {
  const dir = mkdtempSync("/tmp/journal-hardening-");
  const path = `${dir}/intent.sqlite`;
  return Promise.resolve().then(() => run(path, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const journal = (path, binding = config, options = journalOptions()) => new BroadcastIntentJournal(path, binding, options);
function raw(path, action) { const db = new DatabaseSync(path); try { action(db); } finally { db.close(); } }
function processRun(code, expectedSignal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (exit, signal) => exit === 0 || signal === expectedSignal ? resolve(output) : reject(new Error(errors)));
  });
}
const imports = `import { BroadcastIntentJournal } from ${JSON.stringify(new URL("../src/broadcast-intent.js", import.meta.url).href)};
import { journalOptions } from ${JSON.stringify(new URL("./journal-fixture.js", import.meta.url).href)};
import { DatabaseSync } from 'node:sqlite';`;

for (const attack of ["database symlink", "symlinked ancestor", "unsafe higher ancestor", "group directory", "world directory", "broad file", "nonregular database", "wrong owner", "WAL symlink", "SHM permissions"]) {
  test(`rejects ${attack}`, () => fixture((path, dir) => {
    let options = journalOptions();
    if (attack === "database symlink") { writeFileSync(`${dir}/target`, "", { mode: 0o600 }); symlinkSync(`${dir}/target`, path); }
    if (attack === "symlinked ancestor") { mkdirSync(`${dir}/real`, { mode: 0o700 }); symlinkSync(`${dir}/real`, `${dir}/link`); path = `${dir}/link/db`; }
    if (attack === "unsafe higher ancestor") { chmodSync(dir, 0o777); mkdirSync(`${dir}/private`, { mode: 0o700 }); path = `${dir}/private/db`; }
    if (attack === "group directory") chmodSync(dir, 0o770);
    if (attack === "world directory") chmodSync(dir, 0o707);
    if (attack === "broad file") writeFileSync(path, "", { mode: 0o644 });
    if (attack === "nonregular database") mkdirSync(path, { mode: 0o700 });
    if (attack === "wrong owner") { const stat = options.stat; options.stat = p => Object.assign(stat(p), p === dir ? { uid: process.geteuid() + 1 } : {}); }
    if (attack === "WAL symlink") { journal(path).close(); symlinkSync(`${dir}/target`, path + "-wal"); }
    if (attack === "SHM permissions") { journal(path).close(); writeFileSync(path + "-shm", "", { mode: 0o644 }); }
    assert.throws(() => journal(path, config, options), failure);
  }));
}
test("production requires dedicated runtime identity and rejects actual unsafe ancestors", () => fixture(path => {
  assert.throws(() => new BroadcastIntentJournal(path, config), failure);
  assert.throws(() => journal(path, config, { identity: journalOptions().identity }), failure);
}));
test("new database, WAL and SHM are private even with permissive umask", () => fixture(path => {
  const previous = process.umask(0);
  let db;
  try {
    db = journal(path); db.reserve(intent);
    for (const suffix of ["", "-wal", "-shm"]) {
      const info = statSync(path + suffix);
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(info.uid, process.geteuid());
    }
  } finally { db?.close(); process.umask(previous); }
}));

for (const mutation of [
  "DROP TABLE broadcast_intents",
  "ALTER TABLE broadcast_intents ADD COLUMN unexpected TEXT",
  "DROP TABLE broadcast_intents; CREATE TABLE broadcast_intents (transfer_id TEXT PRIMARY KEY NOT NULL, approval_digest TEXT NOT NULL, transaction_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain'))) STRICT",
  "DROP TABLE broadcast_intents; CREATE TABLE broadcast_intents (transfer_id TEXT NOT NULL, approval_digest TEXT NOT NULL, transaction_digest TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain'))) STRICT",
  "DELETE FROM intent_binding",
  "UPDATE intent_binding SET binding = '{}'",
  "UPDATE intent_binding SET binding = json_remove(binding, '$.chainSchema')",
  "UPDATE intent_binding SET binding = json_set(binding, '$.chainSchema.xitcoin', 'unknown')",
  "PRAGMA user_version = 0", "PRAGMA user_version = 2",
  "CREATE INDEX unexpected ON broadcast_intents(state)",
]) {
  test(`rejects existing incompatible schema/binding: ${mutation}`, () => fixture(path => {
    journal(path).close(); raw(path, db => db.exec(mutation));
    for (let i = 0; i < 2; i++) assert.throws(() => journal(path), failure);
  }));
}
test("never adopts an existing empty or invalid database", () => fixture(path => {
  writeFileSync(path, "", { mode: 0o600 });
  assert.throws(() => journal(path), failure);
  writeFileSync(path, "not a SQLite database");
  assert.throws(() => journal(path), failure);
}));
test("concurrent conflicting initialization never adopts the losing binding", () => fixture(async path => {
  const bindings = [config, { ...config, releaseCommit: "b".repeat(40) }];
  const results = await Promise.all(bindings.map(binding => processRun(`${imports}
    try { new BroadcastIntentJournal(${JSON.stringify(path)}, ${JSON.stringify(binding)}, journalOptions()).close(); process.stdout.write('ok'); }
    catch { process.stdout.write('rejected'); }`)));
  assert.equal(results.filter(r => r === "ok").length, 1);
  journal(path, bindings[results.indexOf("ok")]).close();
  assert.throws(() => journal(path, bindings[results.indexOf("rejected")]), failure);
}));
test("SQLite contention fails within a bounded interval without losing reservations", () => fixture(path => {
  const db = journal(path); db.reserve(intent);
  raw(path, locker => {
    locker.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    assert.throws(() => db.markUncertain(intent.transferId), failure);
    assert.ok(performance.now() - start < 3000);
    assert.throws(() => db.reserve(intent), failure);
    assert.throws(() => journal(path), failure);
    locker.exec("ROLLBACK");
  });
  assert.equal(db.reserve(intent).state, "reserved");
  db.close();
}));
test("killed initialization transaction stays rejected rather than repaired", () => fixture(async path => {
  closeSync(openSync(path, "wx", 0o600));
  await processRun(`${imports}
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE intent_binding (id INTEGER PRIMARY KEY, binding TEXT); PRAGMA user_version=1');
    process.kill(process.pid, 'SIGKILL');`, "SIGKILL");
  assert.throws(() => journal(path), failure);
}));
test("interrupted uncertainty update preserves reservation, committed uncertainty survives death", () => fixture(async path => {
  const db = journal(path); db.reserve(intent); db.close();
  await processRun(`${imports}
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec("BEGIN IMMEDIATE; UPDATE broadcast_intents SET state='uncertain'");
    process.kill(process.pid, 'SIGKILL');`, "SIGKILL");
  let reopened = journal(path);
  assert.deepEqual(reopened.reserve(intent), { created: false, state: "reserved", mayBroadcast: false }); reopened.close();
  await processRun(`${imports}
    const db = new BroadcastIntentJournal(${JSON.stringify(path)}, ${JSON.stringify(config)}, journalOptions());
    db.markUncertain(${JSON.stringify(intent.transferId)}); process.kill(process.pid, 'SIGKILL');`, "SIGKILL");
  reopened = journal(path);
  for (let i = 0; i < 5; i++) assert.deepEqual(reopened.reserve(intent), { created: false, state: "uncertain", mayBroadcast: false });
  reopened.close();
}));
test("nonregular WAL is rejected without opening it", () => fixture(path => {
  journal(path).close(); mkdirSync(path + "-wal", { mode: 0o700 });
  assert.throws(() => journal(path), failure);
}));
