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
manifest binds each database to one destination and immutable release. Unique
constraints and an immediate transaction serialize competing processes; WAL and
FULL synchronization persist committed reservations on storage honoring SQLite
sync semantics. Identical reservations are idempotent. Conflicting approvals,
transaction replacement and reuse of a transaction for another transfer fail.
An uncertain intent never expires and cannot be reset through this API.

This is an offline storage prerequisite, not an operational broadcast intent
protocol. Every result has `mayBroadcast: false`. Callers must eventually derive
all identifiers from verified approvals and exact signed bytes; this module only
validates digest syntax. It does not store signed bytes, allocate nonces, verify
quorum or approvals, attest filesystem provisioning, or complete transfers.
It is not imported by startup and does not modify the existing RelayStore.
A future integration must provision a private, trusted local database path,
validate file/ancestor ownership, and define audited release migration. Database
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

Tests cover competing processes, abrupt process exit after a committed intent,
restart, conflicting release/approval/transaction identity and permanent
uncertainty. These are local storage/status tests with synthetic hashes, not
chain transactions, power-loss tests or operational adapter validation.
