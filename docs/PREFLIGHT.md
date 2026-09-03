# Testnet activation preflight

This phase validates the intended deployment without installing units, starting
processes, loading keys or broadcasting transactions. A passing report is a
prerequisite for a later, separately authorized testnet canary; it is not an
authorization to activate the bridge.

## Required evidence

- Pin the release to a complete Git commit and verify its reproducible build.
- Reserve six distinct non-interactive, locked operating-system identities:
  coordinator, three signers and two destination submitters.
- Give every role a distinct private state directory and runtime wrapper owned
  by that role with mode `0700` or stricter.
- Confirm every bridge service is both inactive and disabled.
- Verify Cronos EVM Testnet chain ID `338` and the canonical Xitcoin Testnet
  Chain ID `xitcoin-testnet-v2-1` through independent healthy RPC origins.
  Cronos mainnet chain ID `25` must fail this testnet preflight.
- Bind the manifest to the deployed Cronos test token and vault, the canonical
  route label and derived route ID, the exact ordered signer set, the separate
  guardian, signer-set version `1`, and the configured release limits.
- Read the vault state independently from Cronos testnet and require deployed
  bytecode plus `paused=true`. Resumption is a later 2-of-3 controlled action.
- Preserve only the sanitized pass/fail report and its SHA-256 digest.

## Blocking conditions

Any moving release reference, shared identity, broad permission, enabled or
active service, catching-up node, wrong chain identity or RPC disagreement
blocks the canary. Do not weaken a check to obtain a passing report.

Private endpoints, authentication data, key-provider configuration and operator
keys belong outside this public repository. The eventual canary requires a new
explicit approval because it will use test-only credentials and transactions.

## Live read-only runner

The repository includes a fail-closed command that wires the manifest validator
to host, systemd, Cronos RPC and Xitcoin RPC inspectors:

```sh
npm run preflight:testnet -- /absolute/path/to/testnet-preflight.json
```

Run it only with Node `24.19.0`. The command reads no keystore, creates no
signature, installs no unit and exposes no transaction-submission operation. It
returns a sanitized JSON report and exits non-zero on any failed check or RPC
disagreement. Keep private RPC URLs in the external manifest, never in Git.

`allowLoopbackHttp: true` may be used only for loopback listeners such as two
local ports backed by separate encrypted SSH tunnels. Remote plaintext HTTP is
always rejected. This permits validators to keep CometBFT RPC bound to
`127.0.0.1` and firewalled instead of exposing it publicly.
