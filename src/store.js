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
        transaction_hash TEXT,
        event_index INTEGER,
        payload TEXT NOT NULL,
        approval_request TEXT,
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
      CREATE TABLE IF NOT EXISTS approvals (
        source_chain TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        signer TEXT NOT NULL,
        digest TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_chain, source_ref, signer),
        FOREIGN KEY (source_chain, source_ref)
          REFERENCES transfers(source_chain, source_ref)
      ) STRICT;
    `);
    const columns = new Set(this.database.prepare("PRAGMA table_info(transfers)").all().map((column) => column.name));
    if (!columns.has("transaction_hash")) this.database.exec("ALTER TABLE transfers ADD COLUMN transaction_hash TEXT");
    if (!columns.has("event_index")) this.database.exec("ALTER TABLE transfers ADD COLUMN event_index INTEGER");
    if (!columns.has("approval_request")) this.database.exec("ALTER TABLE transfers ADD COLUMN approval_request TEXT");
  }

  observe(record) {
    const now = Math.floor(Date.now() / 1000);
    const statement = this.database.prepare(`
      INSERT INTO transfers
        (source_chain, source_ref, route_id, state, block_height, block_hash,
         transaction_hash, event_index, payload, updated_at)
      VALUES (?, ?, ?, 'observed', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_chain, source_ref) DO UPDATE SET
        block_height = excluded.block_height,
        block_hash = excluded.block_hash,
        transaction_hash = excluded.transaction_hash,
        event_index = excluded.event_index,
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
      record.transactionHash?.toLowerCase() ?? null,
      record.logIndex ?? record.messageIndex ?? null,
      JSON.stringify(record.payload),
      now,
    );
    return this.get(record.sourceChain, record.sourceRef);
  }

  transition(sourceChain, sourceRef, nextState, details = {}) {
    if (!progress.has(nextState)) throw new Error("unknown lifecycle state");
    const current = this.get(sourceChain, sourceRef);
    if (!current) throw new Error("transfer not found");
    if (["completed", "failed", "reorged"].includes(current.state)) throw new Error("terminal lifecycle state is immutable");
    if (details.destinationRef != null && (nextState !== "submitted"
        || (current.destination_ref !== null && current.destination_ref !== details.destinationRef))) {
      throw new Error("destination reference is immutable");
    }
    const terminalOverride = nextState === "failed" || nextState === "reorged";
    if (!terminalOverride && progress.get(nextState) !== progress.get(current.state) + 1) {
      throw new Error(`invalid lifecycle transition ${current.state} -> ${nextState}`);
    }
    const result = this.database.prepare(`
      UPDATE transfers
      SET state = ?, destination_ref = COALESCE(?, destination_ref),
          error = ?, updated_at = ?
      WHERE source_chain = ? AND source_ref = ? AND state = ? AND destination_ref IS ?
    `).run(
      nextState,
      details.destinationRef ?? null,
      details.error ?? null,
      Math.floor(Date.now() / 1000),
      sourceChain,
      sourceRef.toLowerCase(),
      current.state,
      current.destination_ref,
    );
    if (result.changes !== 1) throw new Error("concurrent lifecycle transition");
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

  persistApprovalRequest(sourceChain, sourceRef, request) {
    const current = this.get(sourceChain, sourceRef);
    if (!current || current.state !== "finalized") throw new Error("approval request requires a finalized transfer");
    const encoded = JSON.stringify(request);
    if (!request || typeof request !== "object" || Array.isArray(request) || encoded.length > 65_536) {
      throw new Error("invalid approval request");
    }
    if (current.approval_request && current.approval_request !== encoded) {
      throw new Error("conflicting approval request");
    }
    if (!current.approval_request) {
      this.database.prepare(`
        UPDATE transfers SET approval_request = ?, updated_at = ?
        WHERE source_chain = ? AND source_ref = ? AND state = 'finalized' AND approval_request IS NULL
      `).run(encoded, Math.floor(Date.now() / 1000), sourceChain, sourceRef.toLowerCase());
    }
    const persisted = this.get(sourceChain, sourceRef);
    if (persisted.state !== "finalized" || persisted.approval_request !== encoded) {
      throw new Error("concurrent or conflicting approval request");
    }
    return JSON.parse(persisted.approval_request);
  }

  approvalRequest(sourceChain, sourceRef) {
    const encoded = this.get(sourceChain, sourceRef)?.approval_request;
    return encoded ? JSON.parse(encoded) : undefined;
  }

  recordApproval(sourceChain, sourceRef, approval) {
    const current = this.get(sourceChain, sourceRef);
    if (!current) throw new Error("transfer not found");
    if (current.state !== "finalized" && current.state !== "approved") {
      throw new Error("approvals may only be recorded for finalized transfers");
    }
    const signer = String(approval.signer).toLowerCase();
    const digest = String(approval.digest).toLowerCase();
    const signature = String(approval.signature).toLowerCase();
    const existing = this.database.prepare(`
      SELECT * FROM approvals
      WHERE source_chain = ? AND source_ref = ? AND signer = ?
    `).get(sourceChain, sourceRef.toLowerCase(), signer);
    if (existing) {
      if (existing.digest !== digest || existing.signature !== signature) {
        throw new Error("conflicting signer approval");
      }
      return existing;
    }
    this.database.prepare(`
      INSERT INTO approvals
        (source_chain, source_ref, signer, digest, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sourceChain, sourceRef.toLowerCase(), signer, digest, signature, Math.floor(Date.now() / 1000));
    return this.database.prepare(`
      SELECT * FROM approvals
      WHERE source_chain = ? AND source_ref = ? AND signer = ?
    `).get(sourceChain, sourceRef.toLowerCase(), signer);
  }

  approvals(sourceChain, sourceRef) {
    return this.database.prepare(`
      SELECT signer, digest, signature, created_at FROM approvals
      WHERE source_chain = ? AND source_ref = ? ORDER BY signer
    `).all(sourceChain, sourceRef.toLowerCase());
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
    const result = this.database.prepare(`
      INSERT INTO checkpoints (source_chain, block_height, block_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_chain) DO UPDATE SET
        block_height = excluded.block_height,
        block_hash = excluded.block_hash,
        updated_at = excluded.updated_at
      WHERE checkpoints.block_height < excluded.block_height
         OR (checkpoints.block_height = excluded.block_height AND checkpoints.block_hash = excluded.block_hash)
    `).run(sourceChain, blockHeight, normalizedHash, Math.floor(Date.now() / 1000));
    if (result.changes !== 1) throw new Error("concurrent checkpoint regression or finality violation");
    return this.checkpoint(sourceChain);
  }

  close() {
    this.database.close();
  }
}
