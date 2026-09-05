import test from "node:test";
import assert from "node:assert/strict";
import { readDestinationResponse } from "../src/destination-response.js";
const failure = { message: "invalid destination response" };
test("bounded immutable destination JSON with no error body disclosure", async () => {
  assert.deepEqual(await readDestinationResponse(() => new Response('{"code":0}')), { code: 0 });
  for (const response of [new Response("secret", { status: 500 }), new Response("secret"),
    new Response(new Uint8Array([0xff])), new Response("x".repeat(40000)), new Response('{"n":9007199254740992}')])
    await assert.rejects(readDestinationResponse(() => response), failure);
});
test("deadline bounds delayed headers, stalled body, endless stream and untrusted cancellation", async () => {
  for (const read of [() => new Promise(() => {}), () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })),
    () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { return new Promise(() => {}); } })),
    () => { throw new Error("secret endpoint and credential"); }]) {
    const start = performance.now();
    await assert.rejects(readDestinationResponse(read, { timeoutMs: 25 }), failure);
    assert(performance.now() - start < 1500);
  }
});
test("rejects unsafe response budget configuration", async () => {
  for (const bounds of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxBytes: 32769 }, { maxBytes: "10" }])
    await assert.rejects(readDestinationResponse(() => {}, bounds), failure);
});
