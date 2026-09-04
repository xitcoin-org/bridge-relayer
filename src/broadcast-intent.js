import { DatabaseSync } from "node:sqlite";
import { validateSubmitterManifest } from "./submitter-manifest.js";

const digest = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const failure = () => new Error("broadcast intent unavailable or conflicting");

// Offline reservation primitive only. A reservation is NEVER permission to send.
// No expiry, deletion, replacement or retry API: uncertainty permanently blocks reuse.
export class BroadcastIntentJournal {
  #database;
  #binding;

  constructor(path, config) {
    const manifest = validateSubmitterManifest(config);
    this.#binding = JSON.stringify(manifest);
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) throw failure();
    try {
      this.#database = new DatabaseSync(path);
      this.#database.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS intent_binding (id INTEGER PRIMARY KEY CHECK(id = 1), binding TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS broadcast_intents (
          transfer_id TEXT PRIMARY KEY, approval_digest TEXT NOT NULL,
          transaction_digest TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain'))
        ) STRICT;
        BEGIN IMMEDIATE;
      `);
      this.#database.prepare("INSERT OR IGNORE INTO intent_binding VALUES (1, ?)").run(this.#binding);
      if (this.#database.prepare("SELECT binding FROM intent_binding WHERE id = 1").get().binding !== this.#binding) throw failure();
      this.#database.exec("COMMIT");
    } catch {
      try { this.#database?.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      this.#database?.close();
      throw failure();
    }
  }

  reserve(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).length !== 3
        || Object.keys(input).some((key) => !["transferId", "approvalDigest", "transactionDigest"].includes(key))) throw failure();
    const { transferId, approvalDigest, transactionDigest } = input;
    if (![transferId, approvalDigest, transactionDigest].every(digest)) throw failure();
    try {
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
      const result = this.#database.prepare("UPDATE broadcast_intents SET state = 'uncertain' WHERE transfer_id = ?").run(transferId);
      if (result.changes !== 1) throw failure();
      return Object.freeze({ state: "uncertain", mayBroadcast: false });
    } catch { throw failure(); }
  }

  close() { this.#database.close(); }
}
