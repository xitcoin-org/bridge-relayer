# Runtime service templates

These units document process separation and hardening only. They are not
installed or enabled by this repository.

Private runtime wrappers must be supplied separately under
`/opt/xitcoin-bridge-runtime`. They inject authenticated RPC transports,
destination broadcasters and external key-provider adapters. Never add keys,
mnemonics, tokens or production endpoints to these templates.

Create distinct system identities for the coordinator, each of the three
signers, and each destination submitter. Review every path and sandbox setting
on the target host before copying a unit into `/etc/systemd/system`.
