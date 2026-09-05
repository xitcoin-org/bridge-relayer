import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { RemoteSignerClient } from "../src/approvals.js";

const secret = "https://user:password@private.example:43101/path Authorization: Bearer secret 192.0.2.1:1234 EPIPE";
const bytes = (value) => new TextEncoder().encode(value);
function client(fetchImpl, options = {}) {
  return new RemoteSignerClient({ url: "https://signer.invalid/approve", identity: "test",
    authorizationHeader: async () => `Bearer ${"a".repeat(32)}`,
    timeoutMs: 100, maxResponseBytes: 64, fetchImpl, ...options });
}
function publicError(code, message) {
  return (error) => {
    assert.equal(error.code, `SIGNER_${code}`);
    assert.equal(error.message, message);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["code", "message"]);
    assert.equal(error.cause, undefined);
    assert.equal(error.stack, undefined);
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.ok(Object.isFrozen(error));
    for (const output of [String(error), inspect(error, { showHidden: true, depth: null }), JSON.stringify(error)]) {
      assert.doesNotMatch(output, /private\.example|password|secret|192\.0\.2|43101|1234|EPIPE|https?:|socket|Authorization|\bat .*\(/);
    }
    return true;
  };
}
const transport = () => publicError("TRANSPORT", "signer transport failed");

test("all injected credential, fetch, response and stream errors are sanitized without inspecting causes", async () => {
  const nested = new Error(secret, { cause: new Error(secret, { cause: { socket: secret } }) });
  nested.headers = { authorization: secret };
  const hostile = new Proxy({}, { get() { throw new Error(secret); } });
  for (const error of [nested, hostile, secret, null, { code: "SIGNER_TIMEOUT", message: secret }]) {
    await assert.rejects(client(async () => { throw error; }).approve({}), transport());
    await assert.rejects(client(async () => {}, { authorizationHeader: async () => { throw error; } }).approve({}), transport());
    const response = new Response(new ReadableStream({ pull(c) { c.error(error); } }));
    await assert.rejects(client(async () => response).approve({}), transport());
    assert.equal(response.body.locked, false);
  }
  for (const property of ["ok", "body", "headers"]) {
    const response = { ok: true, body: new ReadableStream() };
    Object.defineProperty(response, property, { get() { throw nested; } });
    await assert.rejects(client(async () => response).approve({}), transport());
  }
  await assert.rejects(client(async () => ({ ok: false, status: secret })).approve({}), publicError("HTTP", "signer returned HTTP failure"));
  await assert.rejects(client(async () => new Response(`{"${secret}`)).approve({}), publicError("SIZE", "signer response exceeds size limit"));
  await assert.rejects(client(async () => new Response("{secret")).approve({}), publicError("JSON", "signer returned invalid JSON"));
});

test("timers, abort listeners and reader locks are cleaned on every settlement", async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const active = new Set();
  t.mock.method(globalThis, "setTimeout", (callback, ...args) => {
    const timer = realSetTimeout(callback, ...args); active.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => { active.delete(timer); return realClearTimeout(timer); });
  for (const mode of ["success", "error", "timeout", "overflow", "json", "http"]) {
    let signal;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(c) {
        if (mode === "timeout") return new Promise(() => {});
        if (mode === "error") return c.error(new Error(secret));
        c.enqueue(bytes(mode === "overflow" ? "x".repeat(65) : mode === "json" ? "{" : "{}"));
        if (mode !== "overflow") c.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: mode === "http" ? 503 : 200 });
    const operation = client(async (_url, options) => { signal = options.signal; return response; }).approve({});
    if (mode === "success") assert.deepEqual(await operation, {});
    else await assert.rejects(operation);
    assert.equal(signal.aborted, true, mode);
    assert.equal(getEventListeners(signal, "abort").length, 0, mode);
    assert.equal(response.body.locked, false, mode);
    assert.equal(active.size, 0, mode);
    if (["timeout", "overflow", "http"].includes(mode)) assert.equal(cancelled, true, mode);
  }
});

test("throwing, rejecting and nonsettling cancellation cannot replace errors or retain locks", async () => {
  for (const cancel of [() => { throw new Error(secret); }, () => Promise.reject(new Error(secret)), () => new Promise(() => {})]) {
    const response = new Response(new ReadableStream({ pull(c) { c.enqueue(bytes("x".repeat(65))); }, cancel }, { highWaterMark: 0 }));
    await assert.rejects(client(async () => response).approve({}), publicError("SIZE", "signer response exceeds size limit"));
    assert.equal(response.body.locked, false);
    const failed = new Response(new ReadableStream({ cancel }), { status: 503 });
    await assert.rejects(client(async () => failed).approve({}), publicError("HTTP", "signer returned HTTP failure"));
  }
});

// Ephemeral loopback HTTP fixtures only: no bridge service or remote endpoint.
test("native fetch bounds decoded streams, deadlines and truncated sockets", { timeout: 10000 }, async (t) => {
  let redirected = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/redirect") { res.writeHead(302, { location: "/target" }); res.end(); return; }
    if (req.url === "/target") { redirected++; res.end("{}"); return; }
    if (req.url === "/compressed") {
      const data = gzipSync('"' + "x".repeat(1024) + '"');
      res.writeHead(200, { "content-encoding": "gzip", "content-length": data.length }); res.end(data); return;
    }
    if (req.url === "/oversized") { res.writeHead(200); res.flushHeaders(); res.end("x".repeat(65)); return; }
    if (req.url === "/truncated") {
      res.writeHead(200, { "content-length": 16 }); res.write("{}");
      const timer = setTimeout(() => res.destroy(), 20); res.on("close", () => clearTimeout(timer)); return;
    }
    if (req.url === "/delayed") {
      const timer = setTimeout(() => res.end("{}"), 1000); res.on("close", () => clearTimeout(timer)); return;
    }
    if (req.url === "/endless") {
      res.writeHead(200); res.flushHeaders();
      const timer = setInterval(() => res.write(" "), 10); res.on("close", () => clearInterval(timer)); return;
    }
    res.end(req.url === "/json" ? "{secret" : '"' + "x".repeat(62) + '"');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const native = (path) => client(globalThis.fetch, { url: `http://127.0.0.1:${server.address().port}${path}`, allowHttp: true, timeoutMs: 250 });
  for (const path of ["/oversized", "/compressed"]) {
    await assert.rejects(native(path).approve({}), publicError("SIZE", "signer response exceeds size limit"));
  }
  for (const path of ["/delayed", "/endless"]) {
    await assert.rejects(native(path).approve({}), publicError("TIMEOUT", "signer request timed out"));
  }
  await assert.rejects(native("/truncated").approve({}), transport());
  await assert.rejects(native("/redirect").approve({}), transport());
  assert.equal(redirected, 0);
  await assert.rejects(native("/json").approve({}), publicError("JSON", "signer returned invalid JSON"));
  assert.equal(await native("/exact").approve({}), "x".repeat(62));
});
