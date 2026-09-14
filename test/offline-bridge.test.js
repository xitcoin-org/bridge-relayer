import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

async function start(file) {
  const child = spawn(process.execPath, [new URL('../scripts/fixtures/bridge-process.mjs', import.meta.url).pathname, file], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    async call(args) { child.stdin.write(`${JSON.stringify(args)}\n`); const line = await lines.next(); assert.equal(line.done, false, stderr); return JSON.parse(line.value); },
    async close() { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); assert.equal(child.exitCode, 0, stderr); },
  };
}

test('offline process: deposit, finality, quorum, mint, burn, return and persisted replay protection', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xitcoin-bridge-offline-'));
  let worker = await start(join(dir, 'synthetic-state.json'));
  const ok = async args => { const response = await worker.call(args); assert.equal(response.ok, true, response.error); return response.result; };
  const reject = async (args, pattern) => { const before = await ok({ op: 'status' }); const response = await worker.call(args); assert.equal(response.ok, false); assert.match(response.error, pattern); assert.deepEqual(await ok({ op: 'status' }), before); };
  try {
    assert.equal((await ok({ op: 'status' })).paused, true);
    await ok({ op: 'configure' });
    await reject({ op: 'configure' }, /replay/);
    await reject({ op: 'deposit' }, /pause/);
    await ok({ op: 'resume' });
    for (const bad of [{ route: 'wrong' }, { cronosChainId: 25 }, { cosmosChainId: 'xitcoin-testnet-1' }, { evmChainId: 1 }, { vault: '0x3333333333333333333333333333333333333333' }]) {
      await reject({ op: 'deposit', ...bad }, /wrong/);
    }
    await reject({ op: 'deposit', amount: '101' }, /limit/);
    const deposit = await ok({ op: 'deposit', amount: '10' }); assert.equal(deposit.nonce, 1);
    await reject({ op: 'deposit', nonce: 1 }, /nonce replay/);
    for (const [bad, error] of [[{ confirmations: 11 }, /not final/], [{ rpcFailure: true }, /RPC/], [{ reorg: true }, /reorganization/], [{ badSignature: true }, /signer/], [{ signers: [0, 0] }, /duplicate signer/], [{ signers: [0] }, /insufficient/]]) {
      await reject({ op: 'mint', ref: deposit.ref, ...bad }, error);
    }
    await worker.close(); worker = await start(join(dir, 'synthetic-state.json'));
    assert.equal((await ok({ op: 'status' })).locked, '10');
    await ok({ op: 'mint', ref: deposit.ref });
    await reject({ op: 'mint', ref: deposit.ref }, /replay/);
    await ok({ op: 'pause' }); await reject({ op: 'burn' }, /pause/); await ok({ op: 'resume' });
    const burn = await ok({ op: 'burn' });
    await reject({ op: 'release', ref: burn.ref, signers: [0] }, /insufficient/);
    await ok({ op: 'release', ref: burn.ref });
    await worker.close(); worker = await start(join(dir, 'synthetic-state.json'));
    await reject({ op: 'mint', ref: deposit.ref }, /replay/);
    await reject({ op: 'release', ref: burn.ref }, /replay/);
    const final = await ok({ op: 'status' });
    assert.equal(final.locked, '0'); assert.equal(final.minted, '0'); assert.equal(final.returned, '10');
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});
