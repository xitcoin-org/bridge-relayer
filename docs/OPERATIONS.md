# Operations

## Process separation

- Run each signer under an independent operating-system identity and preferably
  on independent infrastructure.
- Run the coordinator without access to signer private keys.
- Allow signer APIs only from authenticated coordinator networks and require
  signer-side source-chain verification.
- Keep transaction submitter keys separate from bridge signer keys.

## Required safety controls

- Pin Cronos and Xitcoin chain identities, vault address, route and asset.
- Require configurable finality depth on both chains.
- Persist observed block hash, height, transaction hash and log index.
- Re-check the canonical block hash before signing and before submission.
- Stop processing automatically on RPC disagreement, reorganization beyond the
  confirmation window, signer-set mismatch or route pause.
- Expose health and metrics without exposing payload signatures or credentials.

## Watcher checkpoints

Each watcher advances its checkpoint only after every event in the scanned
range has passed a second canonical block and transaction check. A checkpoint
at the same height with a different hash is a finality violation and stops the
process. Operators must investigate RPC disagreement or a deep reorganization;
the process must never select one provider silently.

## Network adapters

- Configure at least two independent HTTPS origins for each source chain.
- Never place API keys, usernames or passwords inside an RPC URL. Inject secret
  headers only in a private runtime wrapper outside this public repository.
- Pin Cronos chain ID `25` and the intended Xitcoin CometBFT chain ID before any
  scan begins.
- Reject catching-up Xitcoin nodes, redirects, oversized responses and malformed
  JSON instead of silently retrying a different interpretation.
- Supply the Xitcoin outbound-message decoder from the canonical chain schema.
  The transport deliberately does not guess event attribute names.
- Run the scan loop without signer or submitter credentials. A successful scan
  records only `observed`, `finalized` and checkpoint state.

## Recovery

The coordinator is restart-safe. It resumes non-terminal records from the local
store and queries the destination replay-protection state before resubmission.
Operators must never delete a pending database merely to clear an error.

## Signer transport

- Give every signer endpoint a stable, unique operator identity and an
  independent HTTPS origin.
- Never embed credentials in signer URLs; inject authentication in a private
  runtime wrapper outside this repository.
- Keep signer response limits and timeouts bounded, reject redirects, and stop
  on any invalid response instead of silently lowering the quorum.
- Rotate the configured signer set atomically with the on-chain signer-set
  version. Old-domain approvals must never be reused.
- The public coordinator stores signatures because they are transaction input,
  not secrets. Metrics and logs must nevertheless omit them.

## Isolated signer services

- Run each `IsolatedSignerService` under a distinct operating-system identity
  and preferably on independent infrastructure and RPC providers.
- Inject `verifySource` and `signDigest` from private runtime adapters. The
  public service neither loads nor stores private keys.
- Pin the canonical route, Cronos chain ID, vault, maximum amount and maximum
  deadline window independently on every signer.
- Require transport authorization before reading request bodies. Terminate TLS
  and mutual authentication in a hardened private ingress; never expose the
  approval endpoint directly to the public Internet.
- A signer must independently confirm canonical source finality. Coordinator
  approval or another signer's response is never sufficient evidence.
- Treat source disagreement, a mismatched digest, a wrong signing account or an
  expired request as a hard rejection and emit no signature.

## Activation sequence

Protocol vectors, watcher tests, signer isolation tests, testnet deployment,
fault injection and an independent security review must all succeed before a
route configuration is proposed. Deployment alone does not authorize route
activation.

## Submission recovery

Never manually retry an approved or submitted transfer. Restart the coordinator: it queries the destination status first and resumes from the persisted transaction reference. Broadcasters must be separate, authenticated components. The Xitcoin deployment requires a canonical public attestation-status client before activation.
