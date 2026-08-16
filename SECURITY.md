# Security

Report vulnerabilities privately through the security contact published by the
Xitcoin organization. Do not disclose exploitable bridge issues in a public
issue before coordinated remediation.

Never commit private keys, mnemonics, API credentials, production endpoints,
signer authorization material or operator databases. The relayer coordinator
must not share a process, filesystem identity or credential store with a bridge
signer.

The software in this repository is not a deployment authorization. Route
activation, signer configuration and limit changes require separate operational
approval and destination-chain controls.
