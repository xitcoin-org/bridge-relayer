import { createHash } from "node:crypto";
import { Transaction, keccak256 } from "ethers";
import { requireCronosCustody } from "./cronos-destination.js";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { PrivateJournalPath } from "./journal-path.js";
import { validateSubmitterManifest } from "./submitter-manifest.js";

const digest = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const failure = () => new Error("signed intent unavailable or conflicting");

const CHAIN_SCHEMA = Object.freeze({
  xitcoin: "5ec8692e8fc1813d0892ee535af1a73953a1c4fb",
  cronos: "d3ae7058d4c6697a9ec079864e1891b661de5b3e",
});
const SCHEMA = `CREATE TABLE intent_binding (id INTEGER PRIMARY KEY CHECK(id = 1), binding TEXT NOT NULL) STRICT;
CREATE TABLE signed_intents (
  transfer_id TEXT PRIMARY KEY NOT NULL, approval_digest TEXT NOT NULL,
  transaction_digest TEXT NOT NULL UNIQUE, transaction_hash TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL, nonce TEXT NOT NULL,
  signed_hex TEXT NOT NULL CHECK(length(signed_hex) BETWEEN 4 AND 32768),
  state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain')),
  UNIQUE(account, nonce)
) STRICT;`;
const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";
const reference = new DatabaseSync(":memory:");
reference.exec(SCHEMA);
const EXPECTED_SCHEMA = JSON.stringify(reference.prepare(SCHEMA_QUERY).all());
reference.close();

// Offline reservation primitive only. A reservation is NEVER permission to send.
// No expiry, deletion, replacement or retry API: uncertainty permanently blocks reuse.
export class SignedIntentJournal {
  #database;
  #binding;

  #path;

  constructor(path, config, { identity = userInfo, stat = lstatSync } = {}) {
    try {
      const manifest = validateSubmitterManifest(config);
      if (manifest.destination !== "cronos") throw failure();
      const owner = identity();
      if (owner.username !== `xitcoin-bridge-submitter-${manifest.destination}`
          || !Number.isSafeInteger(owner.uid) || owner.uid <= 0 || owner.uid !== process.geteuid()) throw failure();
      this.#binding = JSON.stringify({ schemaVersion: 1, kind: "offline_cronos_signed_custody", manifest, chainSchema: CHAIN_SCHEMA });
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
      if (this.#binding !== JSON.stringify({ schemaVersion: 1, kind: "offline_cronos_signed_custody", manifest, chainSchema: CHAIN_SCHEMA })) throw failure();
    } catch { throw failure(); }
  }

  reserve(input) {
    try {
      const value = requireCronosCustody(input);
      const { transferId, approvalDigest, transactionDigest, transactionHash, account, nonce, signedHex } = value;
      this.#path.verify();
      this.#database.exec("BEGIN IMMEDIATE");
      const existing = this.#database.prepare("SELECT * FROM signed_intents WHERE transfer_id = ?").get(transferId);
      const expected = { transfer_id: transferId, approval_digest: approvalDigest, transaction_digest: transactionDigest,
        transaction_hash: transactionHash, account, nonce, signed_hex: signedHex };
      if (existing && Object.entries(expected).some(([key, item]) => existing[key] !== item)) throw failure();
      if (!existing) this.#database.prepare("INSERT INTO signed_intents VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')")
        .run(transferId, approvalDigest, transactionDigest, transactionHash, account, nonce, signedHex);
      this.#database.exec("COMMIT");
      return Object.freeze({ created: !existing, state: existing?.state ?? "reserved", mayBroadcast: false });
    } catch {
      try { this.#database.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      throw failure();
    }
  }

  inspect(transferId) {
    try {
      if (!digest(transferId)) throw failure();
      this.#path.verify();
      const row = this.#database.prepare("SELECT * FROM signed_intents WHERE transfer_id = ?").get(transferId);
      if (!row) return Object.freeze({ found: false, mayBroadcast: false });
      const tx = Transaction.from(row.signed_hex);
      if (!digest(row.transfer_id) || !digest(row.approval_digest) || !["reserved", "uncertain"].includes(row.state)
          || !tx.isSigned() || tx.type !== 0 || tx.chainId !== 338n || tx.serialized !== row.signed_hex
          || tx.from !== row.account || String(tx.nonce) !== row.nonce
          || keccak256(row.signed_hex) !== row.transaction_hash
          || `0x${createHash("sha256").update(Buffer.from(row.signed_hex.slice(2), "hex")).digest("hex")}` !== row.transaction_digest) throw failure();
      return Object.freeze({ found: true, state: row.state, transferId: row.transfer_id,
        approvalDigest: row.approval_digest, transactionDigest: row.transaction_digest,
        transactionHash: row.transaction_hash, account: row.account, nonce: row.nonce,
        signedHex: row.signed_hex, mayBroadcast: false });
    } catch { throw failure(); }
  }

  markUncertain(transferId) {
    if (!digest(transferId)) throw failure();
    try {
      this.#path.verify();
      const result = this.#database.prepare("UPDATE signed_intents SET state = 'uncertain' WHERE transfer_id = ?").run(transferId);
      if (result.changes !== 1) throw failure();
      return Object.freeze({ state: "uncertain", mayBroadcast: false });
    } catch { throw failure(); }
  }

  close() { try { this.#database.close(); } finally { this.#path.close(); } }
}
