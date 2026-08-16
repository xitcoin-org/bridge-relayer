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
- Verify Cronos chain ID `25` and the intended Xitcoin testnet chain identity
  through independent healthy RPC origins.
- Preserve only the sanitized pass/fail report and its SHA-256 digest.

## Blocking conditions

Any moving release reference, shared identity, broad permission, enabled or
active service, catching-up node, wrong chain identity or RPC disagreement
blocks the canary. Do not weaken a check to obtain a passing report.

Private endpoints, authentication data, key-provider configuration and operator
keys belong outside this public repository. The eventual canary requires a new
explicit approval because it will use test-only credentials and transactions.
