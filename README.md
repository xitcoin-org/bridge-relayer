# Xitcoin Bridge Relayer

Public protocol and operational tooling for the canonical XTC route between
Cronos and Xitcoin.

This repository separates three responsibilities:

- watchers observe finalized source-chain events;
- a coordinator builds deterministic payloads and records their lifecycle;
- independent signers validate payloads and return approvals.

The coordinator never stores signer private keys. A threshold approval does not
replace source-chain finality checks, route limits, replay protection or the
destination-chain validation performed by the Xitcoin bridge module and the
Cronos vault.

## Current scope

The protocol foundation provides canonical identifiers, address conversion,
EIP-712 release digests, Xitcoin attestation digests, lifecycle persistence and
portable test vectors. Network submission and signer transport are deliberately
excluded until the protocol vectors have been verified against both canonical
repositories.

## Validation

```bash
npm ci
npm run check
npm test
npm run vectors
```

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).
