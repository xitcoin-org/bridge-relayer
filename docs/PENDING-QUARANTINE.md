# Offline pending custody quarantine

`quarantineCronosPending` permanently marks existing, self-consistent Cronos
custody uncertain and fills a missing digest reservation with that same binding.
It commits uncertainty in signed custody first, then reserves and quarantines
the digest journal. A conflict or crash after the first commit leaves blocking
custody. Repeating quarantine cannot replace bytes or reset either journal.

This operation does not require an unexpired approval: its only purpose is to
block known bytes after restart. It cannot construct new signed bytes, grant a
retry, submit a transaction or change RelayStore lifecycle state. Every result
has `mayBroadcast: false`, `mayRetry: false` and `finalized: false`.
There is no startup or CLI integration. Missing custody is an error, not evidence
that a transaction was never submitted. Corrupted or conflicting journals remain
unavailable and require offline investigation; no repair or deletion is offered.

This is local quarantine, not authenticated destination reconciliation. SQLite
self-consistency cannot detect a consistent older backup or a malicious owner.
An exclusive account/nonce authority across programs, authenticated contract and
transaction status, canonical inclusion/finality, and release migration retaining
pending state remain blockers. No chain schema or confirmation count is assumed.

Tests cover custody-only recovery, permanent uncertainty, idempotence, digest
conflicts, database lock failure between commits, reopening custody, corrupted
metadata, manifest mismatches and unchanged RelayStore state. These local tests
are not production-readiness or power-loss proofs.
