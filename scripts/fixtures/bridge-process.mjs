// Offline chain adapters only. Protocol hashes, approvals and source verification
// are the production relayer implementations. No transport or real key is used.
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { Wallet, id } from 'ethers';
import { buildApprovalRequest, collectApprovalQuorum } from '../../src/approvals.js';
import { createCanonicalSourceVerifier } from '../../src/source-verification.js';
import { depositId, DIRECTION_INBOUND, DIRECTION_OUTBOUND } from '../../src/protocol.js';
import { evmAddressToBech32 } from '../../src/address.js';
import { TESTNET_ROUTE_ID } from '../../src/preflight.js';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
const forbidden = () => { throw new Error('network forbidden in offline harness'); };
globalThis.fetch = forbidden;
http.request = https.request = http.get = https.get = net.connect = net.createConnection = forbidden;
const statePath = process.argv[2];
const wallets = [1, 2, 3].map(n => new Wallet(`0x${n.toString(16).padStart(64, '0')}`));
const route = 'cronos-testnet-xitcoin-testnet';
const vault = '0x2222222222222222222222222222222222222222';
const recipient = '0x1111111111111111111111111111111111111111';
const cosmos = evmAddressToBech32(recipient);
let state;
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = { paused: true, configured: false, nonce: 0, locked: '0', minted: '0', returned: '0', deposits: {}, burns: {}, consumed: [] }; }
async function persist() { await fs.writeFile(`${statePath}.next`, JSON.stringify(state), { mode: 0o600 }); await fs.rename(`${statePath}.next`, statePath); }
function requireThat(value, message) { if (!value) throw new Error(message); }
function identity(args) {
  requireThat((args.route ?? route) === route, 'wrong route');
  requireThat((args.cronosChainId ?? 338) === 338, 'wrong Cronos chain ID');
  requireThat((args.cosmosChainId ?? 'xitcoin-testnet-v2-1') === 'xitcoin-testnet-v2-1', 'wrong Cosmos chain ID');
  requireThat((args.evmChainId ?? 101089) === 101089, 'wrong EVM chain ID');
  requireThat((args.vault ?? vault) === vault, 'wrong contract');
}
function active(args) { identity(args); requireThat(state.configured, 'route not configured'); requireThat(!state.paused, 'emergency pause'); }
async function attest(args, direction, payload, record) {
  const watcher = {
    async events() { if (args.rpcFailure) throw new Error('RPC unavailable'); return [record]; },
    async verifyCanonicalEvent() { requireThat(!args.reorg, 'reorganization'); requireThat((args.confirmations ?? 12) >= 12, 'not final'); },
  };
  const request = buildApprovalRequest({ direction, payload });
  const verifySource = createCanonicalSourceVerifier({ cronosWatcher: watcher, xitcoinWatcher: watcher, cronosRouteId: TESTNET_ROUTE_ID });
  await verifySource(request);
  const clients = (args.signers ?? [0, 1]).map((n, i) => ({ identity: `fixture-client-${i}`, async approve(expected) {
    const signer = wallets[n];
    return { digest: expected.digest, signer: signer.address, signature: signer.signingKey.sign(args.badSignature ? id('wrong synthetic message') : expected.digest).serialized };
  } }));
  const approvals = await collectApprovalQuorum({ request, clients, authorizedSigners: wallets.map(w => w.address), threshold: 2, nowUnix: 1000 });
  requireThat(approvals.length === 2, 'quorum');
  return request.digest;
}
async function execute(args) {
  if (args.op === 'status') return structuredClone(state);
  if (args.op === 'configure') { identity(args); requireThat(!state.configured, 'configuration replay'); state.configured = true; await persist(); return state; }
  if (args.op === 'pause') { state.paused = true; await persist(); return state; }
  if (args.op === 'resume') { identity(args); requireThat(state.configured, 'route not configured'); state.paused = false; await persist(); return state; }
  active(args);
  if (args.op === 'deposit') {
    const amount = BigInt(args.amount ?? '10');
    requireThat(amount > 0n && amount <= 100n, 'amount exceeds limit');
    const nonce = args.nonce ?? state.nonce + 1;
    requireThat(nonce === state.nonce + 1, 'nonce replay');
    const ref = depositId({ chainId: 338, vault, routeId: TESTNET_ROUTE_ID, depositor: recipient, recipient, amount, nonce });
    state.deposits[ref] = { amount: String(amount), nonce: String(nonce) };
    state.nonce = nonce; state.locked = String(BigInt(state.locked) + amount); await persist(); return { ref, nonce };
  }
  if (args.op === 'mint') {
    const deposit = state.deposits[args.ref]; requireThat(deposit, 'unknown deposit'); requireThat(!state.consumed.includes(args.ref), 'deposit replay');
    const sourceEvidence = { blockHeight: 10, blockHash: id('synthetic block'), transactionHash: id(args.ref), eventIndex: 0 };
    const payload = { routeId: route, sourceChainId: '338', sourceRef: args.ref, nonce: deposit.nonce, destination: cosmos, amount: deposit.amount, deadlineUnix: '2000', sourceEvidence };
    const record = { ...sourceEvidence, logIndex: 0, routeId: TESTNET_ROUTE_ID, payload: { depositId: args.ref, destination: cosmos, amount: deposit.amount, nonce: deposit.nonce } };
    const digest = await attest(args, DIRECTION_INBOUND, payload, record);
    state.minted = String(BigInt(state.minted) + BigInt(deposit.amount)); state.consumed.push(args.ref); await persist(); return { digest };
  }
  if (args.op === 'burn') {
    const amount = BigInt(args.amount ?? '10'); requireThat(amount > 0n && amount <= BigInt(state.minted), 'insufficient minted balance');
    const ref = id(`synthetic burn ${Object.keys(state.burns).length}`);
    state.burns[ref] = { amount: String(amount) }; state.minted = String(BigInt(state.minted) - amount); await persist(); return { ref };
  }
  if (args.op === 'release') {
    const burn = state.burns[args.ref]; requireThat(burn, 'unknown burn'); requireThat(!state.consumed.includes(args.ref), 'burn replay');
    requireThat(BigInt(burn.amount) <= BigInt(state.locked), 'insufficient vault balance');
    const sourceEvidence = { blockHeight: 20, blockHash: id('synthetic Cosmos block'), transactionHash: id(args.ref), eventIndex: 0 };
    const payload = { routeId: route, chainId: 338, vault, sourceBurnId: args.ref, recipient, amount: burn.amount, signerSetVersion: 1, deadline: 2000, sourceEvidence };
    const record = { ...sourceEvidence, messageIndex: 0, routeId: route, payload: { requestId: args.ref, destination: recipient, amount: burn.amount } };
    const digest = await attest(args, DIRECTION_OUTBOUND, payload, record);
    state.locked = String(BigInt(state.locked) - BigInt(burn.amount)); state.returned = String(BigInt(state.returned) + BigInt(burn.amount)); state.consumed.push(args.ref); await persist(); return { digest };
  }
  throw new Error('unknown operation');
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  try { const result = await execute(JSON.parse(line)); process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`); }
  catch (e) { process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`); }
}
