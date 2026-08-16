# Canonical bridge protocol

## Route identity

The human-readable route identifier is a lower-case string accepted by the
Xitcoin bridge module. The Cronos vault stores its `bytes32` representation as
`keccak256(UTF8(route_id))`. Deployments must publish both values.

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
