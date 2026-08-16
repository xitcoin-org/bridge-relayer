# Controlled testnet canary

The canary is a separately authorized operational event. This repository only
defines the bounded plan, stop conditions and sanitized evidence format; it
does not load keys, start services or broadcast transactions.

## Authorization envelope

- Pin a complete release commit and the successful preflight report digest.
- Use a SHA-256 decision identifier without personal or secret information.
- Limit authorization to one hour or less.
- Permit exactly two very small transfers: Cronos to Xitcoin, then Xitcoin to
  Cronos. The amount ceiling must be approved before the window opens.
- Keep services disabled until the separate operational authorization.

## Immediate stop conditions

Stop without retrying or lowering safeguards on RPC disagreement, deep
reorganization, signer quorum loss, readiness loss, destination mismatch,
failed finality or any duplicate broadcast indication.

## Public evidence

After both chains report canonical finality, record only the release commit,
decision identifier, directions, bounded amounts, source and destination
transaction hashes, final status and report digest. Never publish keys,
mnemonics, tokens, private endpoints, raw RPC responses or signatures.

A passing canary is evidence for final security review. It is not by itself an
authorization for unrestricted or mainnet operation.
