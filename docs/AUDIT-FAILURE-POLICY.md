# Dependency audit failures

The Relayer workflow retries the production dependency audit three times and
preserves its final nonzero exit status. An unavailable registry cannot establish
that unchanged dependencies are still safe: new advisories can appear without a
lockfile change. The previous success fallback for that case is removed.

Local validation on 6 September 2026 passed all 245 protocol/state tests, syntax
checks, vectors, independent protobuf and envelope verification, and the npm
audit with zero findings. A shell simulation of the workflow's audit step checked
exit statuses 0 (success), 1 (rejection) and 7 (registry failure); each was
preserved. The simulation mocked npm and sleep and performed no network call.

The existing published protocol pins and runtime behavior are unchanged. These
checks do not activate the bridge or establish live-chain readiness.
