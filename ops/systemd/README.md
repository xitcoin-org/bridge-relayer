# Runtime service templates

These units document process separation and hardening only. They are not
installed or enabled by this repository.

Signer instances use the reviewed public CLI with a root-owned manifest at
`/etc/xitcoin-bridge/signer-%i.json` and two distinct encrypted systemd
credentials. Coordinator and submitter wrappers remain private runtime adapters.
Never add keys, mnemonics, tokens or private production endpoints to templates
or manifests.

The signer template creates units named `xitcoin-bridge-signer@1.service`
through `@3.service`. Keep them disabled until the immutable release symlink,
root-owned manifest, encrypted credentials, RPC tunnels and complete preflight
have all been reviewed.

Create distinct system identities for the coordinator, each of the three
signers, and each destination submitter. Review every path and sandbox setting
on the target host before copying a unit into `/etc/systemd/system`.
