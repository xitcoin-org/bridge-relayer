import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { PrivateJournalPath } from "./journal-path.js";
import { validateSubmitterManifest } from "./submitter-manifest.js";

const digest = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const failure = () => new Error("broadcast intent unavailable or conflicting");

const CHAIN_SCHEMA = Object.freeze({
  xitcoin: "5ec8692e8fc1813d0892ee535af1a73953a1c4fb",
  cronos: "d3ae7058d4c6697a9ec079864e1891b661de5b3e",
});
const SCHEMA = `CREATE TABLE intent_binding (id INTEGER PRIMARY KEY CHECK(id = 1), binding TEXT NOT NULL) STRICT;
CREATE TABLE broadcast_intents (
  transfer_id TEXT PRIMARY KEY NOT NULL, approval_digest TEXT NOT NULL,
  transaction_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain'))
) STRICT;`;
const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";
const reference = new DatabaseSync(":memory:");
reference.exec(SCHEMA);
const EXPECTED_SCHEMA = JSON.stringify(reference.prepare(SCHEMA_QUERY).all());
reference.close();

// Offline reservation primitive only. A reservation is NEVER permission to send.
// No expiry, deletion, replacement or retry API: uncertainty permanently blocks reuse.
export class BroadcastIntentJournal {
  #database;
  #binding;

  #path;

  constructor(path, config, { identity = userInfo, stat = lstatSync } = {}) {
    try {
      const manifest = validateSubmitterManifest(config);
      const owner = identity();
      if (owner.username !== `xitcoin-bridge-submitter-${manifest.destination}`
          || !Number.isSafeInteger(owner.uid) || owner.uid <= 0 || owner.uid !== process.geteuid()) throw failure();
      this.#binding = JSON.stringify({ schemaVersion: 1, manifest, chainSchema: CHAIN_SCHEMA });
      this.#path = new PrivateJournalPath(path, owner.uid, stat);
      this.#database = new DatabaseSync(this.#path.path, { timeout: 1000 });
      this.#path.verify();
      this.#database.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      if (this.#path.fresh) {
        if (this.#database.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n !== 0) throw failure();
        this.#database.exec(SCHEMA);
        this.#database.exec("PRAGMA user_version = 1");
        this.#database.prepare("INSERT INTO intent_binding VALUES (1, ?)").run(this.#binding);
      }
      this.#validate();
      this.#database.exec("COMMIT");
      if (this.#database.prepare("PRAGMA journal_mode = WAL").get().journal_mode !== "wal") throw failure();
      this.#path.verify();
      if (this.#path.fresh) this.#path.syncCreation();
    } catch {
      try { this.#database?.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      try { this.#database?.close(); } catch { /* Preserve sanitized failure. */ }
      this.#path?.close();
      throw failure();
    }
  }

  #validate() {
    // Exact DDL also checks CHECK/NOT NULL/STRICT, column order, and autoindexes.
    // No migration is supported: unknown or partial schemas require offline review.
    if (this.#database.prepare("PRAGMA user_version").get().user_version !== 1
        || JSON.stringify(this.#database.prepare(SCHEMA_QUERY).all()) !== EXPECTED_SCHEMA) throw failure();
    const rows = this.#database.prepare("SELECT * FROM intent_binding").all();
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].binding !== this.#binding) throw failure();
    if (this.#database.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw failure();
  }

  assertManifest(config) {
    try {
      const manifest = validateSubmitterManifest(config);
      if (this.#binding !== JSON.stringify({ schemaVersion: 1, manifest, chainSchema: CHAIN_SCHEMA })) throw failure();
    } catch { throw failure(); }
  }

  reserve(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).length !== 3
        || Object.keys(input).some((key) => !["transferId", "approvalDigest", "transactionDigest"].includes(key))) throw failure();
    const { transferId, approvalDigest, transactionDigest } = input;
    if (![transferId, approvalDigest, transactionDigest].every(digest)) throw failure();
    try {
      this.#path.verify();
      this.#database.exec("BEGIN IMMEDIATE");
      const existing = this.#database.prepare("SELECT * FROM broadcast_intents WHERE transfer_id = ?").get(transferId);
      if (existing && (existing.approval_digest !== approvalDigest || existing.transaction_digest !== transactionDigest)) throw failure();
      if (!existing) this.#database.prepare("INSERT INTO broadcast_intents VALUES (?, ?, ?, 'reserved')").run(transferId, approvalDigest, transactionDigest);
      this.#database.exec("COMMIT");
      return Object.freeze({ created: !existing, state: existing?.state ?? "reserved", mayBroadcast: false });
    } catch {
      try { this.#database.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      throw failure();
    }
  }

  markUncertain(transferId) {
    if (!digest(transferId)) throw failure();
    try {
      this.#path.verify();
      const result = this.#database.prepare("UPDATE broadcast_intents SET state = 'uncertain' WHERE transfer_id = ?").run(transferId);
      if (result.changes !== 1) throw failure();
      return Object.freeze({ state: "uncertain", mayBroadcast: false });
    } catch { throw failure(); }
  }

  close() { try { this.#database.close(); } finally { this.#path.close(); } }
}
