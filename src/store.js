import { DatabaseSync } from "node:sqlite";

export const STATES = Object.freeze([
  "observed", "finalized", "approved", "submitted", "completed", "failed", "reorged",
]);

const progress = new Map(STATES.map((state, index) => [state, index]));

export class RelayStore {
  constructor(path = ":memory:") {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS transfers (
        source_chain TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        route_id TEXT NOT NULL,
        state TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        destination_ref TEXT,
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_chain, source_ref)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS checkpoints (
        source_chain TEXT PRIMARY KEY,
        block_height INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  observe(record) {
    const now = Math.floor(Date.now() / 1000);
    const statement = this.database.prepare(`
      INSERT INTO transfers
        (source_chain, source_ref, route_id, state, block_height, block_hash, payload, updated_at)
      VALUES (?, ?, ?, 'observed', ?, ?, ?, ?)
      ON CONFLICT(source_chain, source_ref) DO UPDATE SET
        block_height = excluded.block_height,
        block_hash = excluded.block_hash,
        payload = excluded.payload,
        updated_at = excluded.updated_at
      WHERE transfers.state IN ('observed', 'reorged')
    `);
    statement.run(
      record.sourceChain,
      record.sourceRef.toLowerCase(),
      record.routeId,
      record.blockHeight,
      record.blockHash.toLowerCase(),
      JSON.stringify(record.payload),
      now,
    );
    return this.get(record.sourceChain, record.sourceRef);
  }

  transition(sourceChain, sourceRef, nextState, details = {}) {
    if (!progress.has(nextState)) throw new Error("unknown lifecycle state");
    const current = this.get(sourceChain, sourceRef);
    if (!current) throw new Error("transfer not found");
    const terminalOverride = nextState === "failed" || nextState === "reorged";
    if (!terminalOverride && progress.get(nextState) !== progress.get(current.state) + 1) {
      throw new Error(`invalid lifecycle transition ${current.state} -> ${nextState}`);
    }
    this.database.prepare(`
      UPDATE transfers
      SET state = ?, destination_ref = COALESCE(?, destination_ref),
          error = ?, updated_at = ?
      WHERE source_chain = ? AND source_ref = ?
    `).run(
      nextState,
      details.destinationRef ?? null,
      details.error ?? null,
      Math.floor(Date.now() / 1000),
      sourceChain,
      sourceRef.toLowerCase(),
    );
    return this.get(sourceChain, sourceRef);
  }

  get(sourceChain, sourceRef) {
    return this.database.prepare(
      "SELECT * FROM transfers WHERE source_chain = ? AND source_ref = ?",
    ).get(sourceChain, sourceRef.toLowerCase());
  }

  pending() {
    return this.database.prepare(
      "SELECT * FROM transfers WHERE state NOT IN ('completed', 'failed', 'reorged') ORDER BY updated_at",
    ).all();
  }

  checkpoint(sourceChain) {
    return this.database.prepare(
      "SELECT * FROM checkpoints WHERE source_chain = ?",
    ).get(sourceChain);
  }

  advanceCheckpoint(sourceChain, blockHeight, blockHash) {
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
      throw new Error("checkpoint height must be a non-negative safe integer");
    }
    const normalizedHash = String(blockHash).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalizedHash)) throw new Error("invalid checkpoint hash");
    const current = this.checkpoint(sourceChain);
    if (current && blockHeight < current.block_height) throw new Error("checkpoint regression");
    if (current && blockHeight === current.block_height && normalizedHash !== current.block_hash) {
      throw new Error("checkpoint finality violation");
    }
    this.database.prepare(`
      INSERT INTO checkpoints (source_chain, block_height, block_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_chain) DO UPDATE SET
        block_height = excluded.block_height,
        block_hash = excluded.block_hash,
        updated_at = excluded.updated_at
    `).run(sourceChain, blockHeight, normalizedHash, Math.floor(Date.now() / 1000));
    return this.checkpoint(sourceChain);
  }

  close() {
    this.database.close();
  }
}
