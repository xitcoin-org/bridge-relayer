import { FinalityViolation } from "./watchers.js";

function height(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return number;
}

export async function scanFinalizedBatch({ watcher, store, sourceChain, startHeight = 1, maxBatch = 100 }) {
  if (!watcher || !store || !sourceChain) throw new Error("watcher, store and source chain are required");
  const first = height(startHeight, "start height");
  const batch = height(maxBatch, "maximum batch");
  if (batch < 1) throw new Error("maximum batch must be positive");
  const checkpoint = store.checkpoint(sourceChain);
  const from = checkpoint ? checkpoint.block_height + 1 : first;
  const finalized = height(await watcher.latestFinalizedHeight(), "finalized height");
  if (from > finalized) return { from, to: finalized, observed: 0, idle: true };
  const to = Math.min(finalized, from + batch - 1);
  const events = await watcher.events(from, to);
  for (const record of events) {
    if (record.sourceChain !== sourceChain) throw new FinalityViolation("watcher returned the wrong source chain");
    await watcher.verifyCanonicalEvent(record);
    const current = store.observe(record);
    if (current.state === "observed") store.transition(sourceChain, record.sourceRef, "finalized");
  }
  const canonical = await watcher.canonicalBlock(to);
  if (Number(canonical.height ?? canonical.number) !== to) {
    throw new FinalityViolation("checkpoint block height mismatch");
  }
  store.advanceCheckpoint(sourceChain, to, canonical.hash);
  return { from, to, observed: events.length, idle: false };
}
