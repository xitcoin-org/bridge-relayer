# Durable offline custody review

INO internal review, 5 September 2026. PR #43 originally reviewed at
`3b557040558aef513b79f18189df8d6ea54d2745`; dependency fixes from #42 and
main have been merged without rewriting history. No broadcast/completion
permission exists in this integration.

## Corrected finding (Low; integrity of offline inspection)

`SignedIntentJournal.inspect` checked the signed-byte hashes and destination
but did not reconstruct the stored transfer ID and approval digest from the
signed release calldata. Valid-format changes to either metadata column could
be returned as a found reservation after restart. This requires local database
corruption or modification, not network control. It did not grant send permission.

A regression failed before the fix. Inspection now decodes and canonically
re-encodes the release call, binds its burn ID and EIP-712 approval digest,
checks zero transaction value and basic approval shape, and rejects malformed
bytes before transaction parsing. The corrected integration passes 230 tests.

## Verified behavior and limits

Private file ownership, symlink/hardlink/mode checks, pinned ancestors and inode
checks protect against other-user filesystem replacement within the documented
Linux trust model. SQLite uniqueness binds transfer, transaction hash, digest
and account/nonce. Identical reservations are idempotent; replacements fail.
The journal is bound to the disabled manifest and release revision. Release
changes with pending state fail; no migration or discard API exists.

RelayStore is locked during source/approval reconstruction. Custody commits
before the digest intent journal, leaving blocking custody after a partial
commit. Child-process crash and competing-worker tests cover this boundary.
Uncertainty never resets through supported APIs; no retry or lifecycle advance
is returned. Exact code identity is immutable per reservation, but supplied
code hashes and signer state are not authenticated deployment observations.

A privileged/local-owner adversary or a whole consistent old database restore
is outside SQLite self-consistency guarantees. Detecting rollback/deletion,
exclusive account ownership across separate journals, authenticated canonical
receipt/block evidence, coordinated upgrades, and operational reconciliation
remain explicit blockers. Existing offline reservations cannot prove a send
occurred, failed, or finalized. Independent source and destination evidence is
required before any future completion implementation.
