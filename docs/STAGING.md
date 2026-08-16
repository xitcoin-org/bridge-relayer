# Deterministic staging harness

The staging harness exercises the public bridge components with injected,
in-memory adapters. It never contacts a live RPC endpoint, loads an operator
key, starts a service, deploys a contract or broadcasts a transaction.

Required rehearsals before testnet activation:

1. finalized source observation through a two-of-three quorum and canonical
   destination confirmation;
2. continued quorum availability with one signer offline;
3. immediate stop on RPC or canonical block disagreement before checkpointing;
4. recovery after a simulated crash without a second broadcast;
5. idempotent completion and rejection of mismatched destination finality;
6. sanitized reports that contain no payload, signature, endpoint or raw error.

Fault points use stable public codes. Their reports are deterministic and
content-addressed with SHA-256 so repeated rehearsals can be compared without
recording sensitive runtime data.
