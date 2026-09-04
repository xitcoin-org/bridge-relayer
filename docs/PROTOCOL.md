# Canonical bridge protocol

## Route identity

The human-readable route identifier is a lower-case string accepted by the
Xitcoin bridge module. The Cronos vault stores a deployment-pinned `bytes32`
route identifier. A deployment must publish and bind both values explicitly;
the relayer must never assume that the deployed Cronos value can be derived
from the Xitcoin display identifier.

For the canonical testnet deployment, the Xitcoin route is
`cronos-testnet-xitcoin-testnet`, while the Cronos route is
`0x21121c16b53a726056a6683f00c7eb4da5501ce8a2abc8a4677e06f1e94b5cd9`
on Cronos EVM chain ID `338`.

## Cronos to Xitcoin

1. A user calls `CronosBridgeVault.deposit(amount, recipient)`.
2. `recipient` is an EVM address representing the same 20 account bytes used by
   Xitcoin. The relayer converts those bytes to the configured Xitcoin Bech32
   prefix; it does not derive or change the account.
3. The watcher waits for the configured Cronos confirmation depth and rejects
   logs removed by a chain reorganization.
4. The canonical source reference is the emitted `depositId`, without `0x` and
   in lower case. The emitted `nonce` is the attestation nonce.
5. Signers approve the Xitcoin attestation digest only after independently
   checking the finalized receipt, vault address, route, asset and amount.
6. The coordinator submits two distinct approvals to `MsgSubmitAttestation`.

The Xitcoin attestation ID is SHA-256 over the following UTF-8 fields joined by
a zero byte:

```text
route_id
direction
source_chain_id
source_ref
nonce
destination
amount
deadline_unix
```

The approval digest is `keccak256(UTF8("xitcoin-bridge-testnet-attestation-v1") || attestation_id)`.
It is a raw digest and must not receive an Ethereum personal-sign prefix.

## Xitcoin to Cronos

1. The owner submits `MsgInitiateOutboundTransfer` on Xitcoin.
2. Xitcoin transfers the owner's native `axtc` to the bridge module and performs
   a real burn.
3. The canonical `request_id` emitted by Xitcoin becomes the Cronos
   `sourceBurnId`.
4. Signers independently verify the finalized burn and approve the vault's
   EIP-712 `Release` payload.
5. Any submitter may relay the two approvals to the Cronos vault.

The EIP-712 domain is bound to the Cronos chain ID and deployed vault address.
The payload includes the current signer-set version and an expiry.

## Idempotency

Every source reference is unique within its source chain and route. The local
store rejects lifecycle regression, while both destination implementations
enforce their own replay protection. Local completion is recorded only after a
finalized destination receipt.

## Approval coordinator

The coordinator never receives private keys. It sends the complete canonical
payload and its independently recomputed digest to three isolated signer
services. Every returned signature is recovered locally against the currently
authorized three-address signer set. Exactly two distinct valid approvals are
selected in deterministic address order and persisted before the lifecycle is
advanced to `approved`.

Signer services must recompute the digest and re-check the finalized source
event themselves. A mismatched digest, unauthorized or duplicate signer,
expired deadline, wrong chain/vault domain, malformed response, or conflicting
previous approval stops processing. Approval collection does not submit a
transaction to either destination chain.

## Destination submission

An approved transfer is checked against the destination replay key before broadcast. Cronos uses `sourceBurnId`; Xitcoin uses `attestationId`. A recovered processed record must include a canonical transaction reference. A submission becomes completed only after the finalized receipt/event matches every bound field. RPC disagreement or a mismatched event stops processing.
