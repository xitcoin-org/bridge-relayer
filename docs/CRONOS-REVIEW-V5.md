# Offline Cronos prerequisite review

INO internal review, 5 September 2026. This is not an independent audit or a
production-readiness assessment. All APIs remain offline and `mayBroadcast: false`.

The original PR #42 head was `356adfce4de3141004281ca1b24017716ff200bf`.
Its deleted dependency base caused GitHub to close it without merging. Main's
reviewed signature and quorum-order corrections are now integrated without
rewriting history.

## Corrected integration finding (Low; availability)

Main preserves original recovery bytes 0/1 for the pinned Xitcoin verifier.
The reviewed CronosBridgeVault uses OpenZeppelin 5.4.0 `ECDSA.recover(bytes)`,
which requires 27/28. Passing preserved 0/1 bytes to the vault would revert.
The Cronos adapter now rejects these bytes without changing Xitcoin semantics.
Regression cases cover both quorum positions and reversed approval order.

## Verified boundaries and remaining evidence

- Exact chain ID 338, vault, route, recipient, amount, approval digest and
  signer-version binding; reviewed release ABI and Released event.
- Only canonical signed legacy type-0 bytes are accepted. Sender, nonce, value,
  calldata, gas and price must match the frozen plan. SHA-256 digest and Keccak
  transaction hash are distinct. EIP-1559 support is not asserted.
- Local fee caps bound gas, price and their product. Actual network fee-mode
  support, nonce ownership, liquidity and contract release limits remain external
  evidence requirements. This prerequisite alone does not reserve a nonce.
- Supplied code hash, state block hash, pause/replay state and authorized signer
  set are structurally checked offline, not authenticated chain observations.
- Bounded JSON acquisition, UTF-8 decoding, byte/read limits, deadlines and
  sanitized errors include immediately resolved empty streams.
- Inclusion checks only the supplied normalized receipt/event against signed
  bytes and matching supplied block hashes. It never establishes consensus
  finality or permits lifecycle completion. Receipt authenticity, actual input
  lookup, block membership and independent finality remain unresolved.

Original head: 190 tests. Corrected integration: 207 tests, vectors, syntax
and dependency audit pass. These are synthetic offline fixtures. Fresh review
of the corrected head is required before merge; operational startup is disabled.

Receipt topic shape permits zero-valued unrelated topics; the exact Released
event match still requires the approved burn, recipient, amount and version.
