# Destination adapter work in progress

Both public submitter startup paths remain disabled. No wallet, RPC transport,
credential loader or broadcaster is connected by this work.

## Verified source evidence

The chain source at commit
[`5ec8692e8fc1813d0892ee535af1a73953a1c4fb`](https://github.com/xitcoin-org/pos-chain/tree/5ec8692e8fc1813d0892ee535af1a73953a1c4fb/proto/cosmos/evm/bridge/v1)
contains `MsgSubmitAttestation` in `tx.proto` and `AttestationStatus` in
`query.proto`. A verbatim query schema is checked in at
[evidence/xitcoin-query.proto](evidence/xitcoin-query.proto). The status response
contains only `attestation_id` and `processed`. It provides no transaction
reference, approved payload, block identity, pending state or finality proof.
The offline status inspector validates an explicit two-field response and never
authorizes sending or completion. Omitted protobuf JSON default fields fail
closed; gateway compatibility has not been verified.

The vault ABI is checked against
[`contracts` at d3ae7058d4c6697a9ec079864e1891b661de5b3e](https://github.com/xitcoin-org/contracts/blob/d3ae7058d4c6697a9ec079864e1891b661de5b3e/contracts/cronos/bridge/CronosBridgeVault.sol).
Source availability does not prove the identity or state of a deployed contract.

## Independent durable component

`BroadcastIntentJournal` reserves a transfer ID, approval digest and exact
transaction digest in a dedicated SQLite database. The full disabled testnet
manifest, schema version 1, and both immutable chain schema source commits above
bind each database to one destination and release. Only exclusive file creation
initializes a journal; reopening requires exact table DDL, constraints, indexes,
version and complete binding metadata. Missing, legacy, partial or incompatible
state is rejected without adoption or repair. There is no automatic migration;
any release/schema migration requires a separately reviewed offline procedure
that preserves every reservation and uncertainty record. Unique
constraints and an immediate transaction serialize competing processes; WAL and
FULL synchronization persist committed reservations on storage honoring SQLite
sync semantics. Identical reservations are idempotent. Conflicting approvals,
transaction replacement and reuse of a transaction for another transfer fail.
An uncertain intent never expires and cannot be reset through this API.

This is an offline storage prerequisite, not an operational broadcast intent
protocol. Every result has `mayBroadcast: false`. Callers must eventually derive
all identifiers from verified approvals and exact signed bytes; this module only
validates digest syntax. It does not store signed bytes, allocate nonces, verify
quorum or approvals, or complete transfers.
It is not imported by startup and does not modify the existing RelayStore.
Linux journal access requires the service identity
`xitcoin-bridge-submitter-<destination>`, a private service-owned parent, and
root/service-owned ancestors with no group/world write permissions, including
higher ancestors. Symlinks, nonregular files, hard links, foreign owners and
nonprivate database/sidecar files are rejected. Exclusive creation uses mode
0600; SQLite inherits database permissions for WAL/SHM even under a permissive
umask. Directory descriptors opened with O_DIRECTORY/O_NOFOLLOW anchor traversal;
the database uses O_EXCL/O_NOFOLLOW and inode checks before/after SQLite open and
before mutations. Creation also synchronizes the database and parent directory.
Node's SQLite API cannot open an existing descriptor and may canonicalize its
pathname, so these checks minimize but cannot eliminate replacement races by
root or the dedicated service identity. Those identities and local storage must
remain trusted. Test-only dependency injection substitutes identity and ancestor
metadata; no production caller supplies those dependencies. Database
contents and file integrity are trusted; this primitive does not resist local
state tampering or rollback. Do not delete pending state to change releases.

## Remaining activation blockers

- Xitcoin: bind the reviewed message schema to a tested signed transaction
  envelope, sign mode, sequence/account lookup, fee/gas bounds and response
  semantics; obtain transaction/payload/block/finality evidence beyond the
  replay flag. No wire format is inferred from a message name.
- Cronos: verify deployed testnet vault code identity, independent receipts,
  transaction input, replay state, route/pause state and authorized signer quorum;
  implement account nonce ownership and bounded fees.
- Both: a bounded transport enforcing timeouts while streaming responses,
  durable signed-byte custody, approval-to-transfer revalidation, pending-send
  reconciliation, canonical finality verification and crash-safe integration
  with RelayStore. An absent replay flag must never authorize a retry after an
  uncertain send.

`submitApprovedTransfer` requires a plain adapter status with own data fields
`processed: false` and `mayBroadcast: true` before calling `adapter.submit`.
Only deterministic test mocks currently grant that permission. The offline
journal and replay inspector always return false; neither is a broadcast
capability. Future trusted adapters must validate authorization against the
request and durable intent before ever returning true.

The replay inspector accepts only plain objects with exactly two enumerable
scalar data fields (depth one, a 64-character ID and a boolean). Accessors,
proxies, symbols, unexpected prototypes and extra/nested values fail with a
sanitized error. Transport streaming byte limits and an overall timeout are
mandatory before JSON parsing; this object inspector cannot bound transport
allocation or parsing time.

Tests cover unsafe files/ancestors, private DB/WAL/SHM creation, incompatible
schemas and metadata, competing and conflicting initialization, one-second
SQLite lock timeouts, killed initialization and uncertainty transactions,
restart, invalid database/nonregular WAL conditions, conflicting identities,
repeated ambiguous attempts and permanent uncertainty. These are local storage/status
tests with synthetic hashes, not chain transactions, power-loss tests or operational adapter validation.

## Signer transport hardening (not destination readiness)

The signer approval client now counts streamed response bytes before retaining
chunks and rejects oversized, malformed UTF-8 and nonstreaming responses. Its
overall deadline covers authentication, response headers and body reads; read
failure cancels the stream without waiting indefinitely for cancellation.
Redirects remain forbidden. Offline tests use synthetic responses and stalled
promises; no signer service is contacted. Injected dependencies must honor abort
to release their own resources even though the caller settles on deadline.

This hardening does not cover the existing ethers-based CometBFT or Cronos
transports, which still need bounded streaming review before use by destination
adapters. It supplies no broadcast permission and leaves startup disabled.

## Offline Xitcoin message construction (operational-v1)

`prepareXitcoinAttestation` builds only
`/cosmos.evm.bridge.v1.MsgSubmitAttestation`, using the verbatim pinned
[transaction schema](evidence/xitcoin-tx.proto) and the generated `tx.pb.go`
marshal tags at the same pos-chain commit. It binds the local plan to
`xitcoin-testnet-v2-1`, source chain `338`, and the disabled manifest route.
It verifies every signature against an explicitly supplied three-member set,
rejects duplicate/unauthorized approvals and altered request digests, and orders
signatures deterministically. That supplied set still requires authenticated
canonical chain-state evidence before runtime use. Input snapshots reject object
traps, excessive depth/size, coercion and unsafe integers. Output strings and
metadata are frozen; `messageDigest` is SHA-256 of the message only, **not a
transaction hash**. Chain ID is plan metadata; this message schema has no
chain-ID field for the destination. Transaction-level binding is still missing.

Local stricter policy requires canonical decimal strings, positive uint64 nonce,
positive uint256 amount, safe-integer positive int64 deadline, canonical 20-byte
`xtc` addresses and 2–3 signatures. This intentionally rejects some representations
the chain may normalize. The fixture uses synthetic public keys, not chain
transactions; its byte layout is checked against the pinned generated Go encoder.
A chain-generated differential signing vector remains required.

Additional inspected evidence: pos-chain `encoding/config.go` selects SDK
`tx.DefaultSignModes`, and `go.mod` pins Cosmos SDK v0.54.4 and CometBFT v0.39.4.
Those dependency declarations alone do not validate this relayer's TxRaw,
AuthInfo, SignDoc, public-key Any, signer account type, account query responses,
fees, execution response handling or finality verifier. None is fabricated here.
Testnets commit `1633957e805f6782b201a623335c9eebafa0cece`,
`xitcoin-testnet-v2-1/chain.json`, identifies `axtc` and a disabled, unconfigured
bridge route; no live endpoint was queried. `mayBroadcast` remains false.
