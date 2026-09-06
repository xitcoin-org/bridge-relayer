# Offline Xitcoin ordered direct envelope

This module is not connected to startup, a signer, a chain endpoint or a
broadcaster. Every result keeps `mayBroadcast: false` and `finalized: false`.
It accepts supplied offline account observations and already supplied signatures;
it never loads a key or signs a transaction.

## Authoritative schema and signature evidence

- pos-chain `5ec8692e8fc1813d0892ee535af1a73953a1c4fb`, `go.mod`, pins
  Cosmos SDK v0.54.4. `encoding/config.go` and `evmd/app.go` enable the SDK's
  default signing modes, including SIGN_MODE_DIRECT.
- Cosmos SDK v0.54.4 resolves to `dedeb7c80a91c47ae83f5352e29c3dd34e4a3fc6`.
  Its `proto/cosmos/tx/v1beta1/tx.proto` is copied in `docs/evidence/` for
  review (upstream Cosmos SDK Apache-2.0 source). `x/auth/tx/config.go` declares
  DIRECT among the enabled defaults. The proto specifies SHA-256 of TxRaw as
  the transaction hash.
- Pinned pos-chain `proto/cosmos/evm/crypto/v1/ethsecp256k1/keys.proto` defines
  the compressed 33-byte public key at field 1 and its Any type URL.
- Pinned `crypto/ethsecp256k1/ethsecp256k1.go` verifies ECDSA over Keccak of
  SignDoc bytes and accepts the recoverable 65-byte signature form. This local
  subset requires low-s and original recovery byte 0/1; other modes/forms fail.

## Supported offline subset

One reconstructed, quorum-verified MsgSubmitAttestation in TxBody, one signer,
DIRECT mode, ordered sequence, one positive `axtc` fee, locally bounded gas and
fee, optional unsigned timeout height. Zero account number, zero sequence and
zero timeout use proto3 omission; uint64 boundaries are exact. Memo, extensions,
fee grants, multiple signers, unordered transactions, textual and Amino modes
are intentionally unsupported. Unknown fields are rejected.

The compressed public key must derive the message submitter. The envelope binds
chain, account number, sequence, approvals, message and fee. Only a capability
returned by preparation can accept a matching supplied signature. The signed
result stores deterministic TxRaw bytes for that exact signature, their SHA-256
hash, and the distinct Keccak signing digest in the preparation result. It does
not promise an external signer uses deterministic nonce generation.

## Verification and blockers

The synthetic public fixture is independently decoded and re-encoded with
Python protobuf 6.33.5 by `test/reference/verify-xitcoin-envelope.py`. It is not
a chain-generated differential vector. The normal Node suite checks exact
fixture bytes, wrong keys/signatures, mutated approvals, chain/account/fee
changes, integer boundaries and hostile input accessors.

No account observation is independently authenticated here. An arbitrary supplied
block hash is not consensus evidence. Exclusive durable sequence ownership,
rollback-resistant custody, pending-send reconciliation, canonical transaction
and block inclusion, and execution/finality verification remain prerequisites.
The module cannot reserve, broadcast, retry, advance RelayStore or complete a
transfer. A chain-generated sign-mode vector is required before runtime work.
No actual minimum gas price, finality count or RPC schema is invented.
