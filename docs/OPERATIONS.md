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
- For testnet preflight and canary runs, pin Cronos EVM Testnet chain ID `338`
  and the canonical Xitcoin CometBFT chain ID `xitcoin-testnet-v2-1` before any
  scan begins. Reject Cronos mainnet chain ID `25` in the testnet profile.
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

## Encrypted signer credentials

- Pass the keystore password with `LoadCredentialEncrypted=` and read it only
  from the service's runtime credential directory. Do not pass passwords in an
  environment variable, command-line argument, unit file or persistent wrapper.
- Keep the encrypted JSON keystore and runtime credential owned by the signer
  service identity and owner-private. The secure loader opens each absolute path
  with `O_NOFOLLOW`, checks the effective owner UID, rejects non-regular files,
  group/world access, empty input and oversized input before decryption.
- Pin the expected signer address independently from the keystore. A successful
  decryption with any other account is a hard startup failure.
- Keep core dumps disabled and logs sanitized. The loader intentionally reports
  a bounded failure code instead of the keystore path, password, decrypted
  account or underlying decryption error.
- A transport bearer credential must be independent from the keystore password,
  be generated from at least 32 cryptographically random bytes and be supplied
  as a separate encrypted systemd credential. The loader enforces the resulting
  token length; comparison is constant-time for equal-length candidates.
- Loading key material does not authorize a signature. Route policy, request
  bounds and independent canonical source verification still run before every
  digest signing operation.

## Activation sequence

Protocol vectors, watcher tests, signer isolation tests, testnet deployment,
fault injection and an independent security review must all succeed before a
route configuration is proposed. Deployment alone does not authorize route
activation.

## Runtime composition

- Keep the coordinator, three signers and two destination submitters under six
  distinct operating-system identities.
- Require at least two independent HTTPS RPC origins for each chain and reject
  credentials embedded in URLs.
- A critical watcher, approval or submission worker failure halts the runtime;
  operators must investigate instead of skipping the failed stage.
- `/livez` reports process liveness. `/readyz` becomes successful only after
  every worker has completed recently and successfully. Health output contains
  no payload, signature, endpoint, credential or raw error message.
- The units under `ops/systemd` are documentation templates. Do not install,
  enable or start them until private adapters, host paths and sandbox controls
  have passed staging review.

## Staging rehearsals

- Run every scenario in [`STAGING.md`](STAGING.md) before introducing private
  adapters or operator credentials.
- Preserve only the sanitized report digest and pass/fail codes. Never persist
  test signatures, payloads, RPC responses or injected private errors.
- A failed scenario blocks activation. Do not lower quorum, skip canonical
  checks, advance checkpoints or retry a broadcast to make a rehearsal pass.
- Repeat the complete rehearsal after any protocol, watcher, signer, runtime,
  dependency or destination-contract change.

## Submission recovery

Never manually retry an approved or submitted transfer. Restart the coordinator: it queries the destination status first and resumes from the persisted transaction reference. Broadcasters must be separate, authenticated components. The Xitcoin deployment requires a canonical public attestation-status client before activation.

## Testnet preflight

- Follow [`PREFLIGHT.md`](PREFLIGHT.md) with a full immutable release commit.
- Confirm all six runtime identities are distinct, locked and non-interactive.
- Require owner-bound state directories and wrappers with mode `0700` or stricter.
- Confirm every bridge service remains inactive and disabled during preflight.
- Reject wrong chain identities, catching-up nodes and non-independent RPCs.
- A passing preflight permits review of a testnet canary plan only; it does not
  authorize service activation, key loading, deployment or a transaction.

## Controlled testnet canary

- Follow [`CANARY.md`](CANARY.md) under a separate, time-bounded authorization.
- Bind the decision to the immutable release and successful preflight digest.
- Permit exactly one small finalized transfer per canonical direction.
- Stop immediately on disagreement, quorum loss, readiness loss, finality
  failure, destination mismatch or duplicate-broadcast evidence.
- Publish only sanitized transaction hashes and the SHA-256 report digest.
- Require a separate final review before any unrestricted or live activation.
