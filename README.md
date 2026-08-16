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

The current foundation provides canonical identifiers, address conversion,
EIP-712 release digests, Xitcoin attestation digests, lifecycle persistence,
portable test vectors and finalized source watchers. Cronos observations require
agreement between independent RPC providers, a configured confirmation depth and
a canonical receipt re-check. Xitcoin observations require matching CometBFT
chain identity, block hashes and decoded outbound messages from independent
clients. Hardened network adapters pin chain identities, reject embedded RPC
credentials and require independent HTTPS origins. The restart-safe scan loop
advances checkpoints only after a second canonical event and block verification.
Xitcoin message decoding remains an explicit canonical dependency rather than a
heuristic event parser. The approval coordinator requests bounded HTTPS
responses from isolated signers, recovers each signer locally, persists an
immutable deterministic 2-of-3 quorum and remains restart-safe. Network
submission and private-key handling remain deliberately excluded.

## Validation

```bash
npm ci
npm run check
npm test
npm run vectors
```

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).
