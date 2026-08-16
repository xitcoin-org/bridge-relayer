import { Buffer } from "node:buffer";

function nonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive safe integer`);
  return number;
}

function identities(values, expected, label) {
  if (!Array.isArray(values) || values.length !== expected) throw new Error(`exactly ${expected} ${label} are required`);
  const normalized = values.map((value) => nonEmpty(value, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be distinct`);
  return normalized;
}

function independentOrigins(values, label) {
  if (!Array.isArray(values) || values.length < 2) throw new Error(`at least two ${label} origins are required`);
  const origins = values.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error(`${label} origins must use HTTPS`);
    if (url.username || url.password) throw new Error(`${label} credentials must not be embedded in URLs`);
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error(`${label} origins must be independent`);
  return origins;
}

export function validateRuntimeTopology({ coordinatorIdentity, signerIdentities, submitterIdentities, cronosRpcUrls, xitcoinRpcUrls }) {
  const coordinator = nonEmpty(coordinatorIdentity, "coordinator identity");
  const signers = identities(signerIdentities, 3, "signer identities");
  const submitters = identities(submitterIdentities, 2, "submitter identities");
  const roles = [coordinator, ...signers, ...submitters];
  if (new Set(roles).size !== roles.length) throw new Error("runtime role identities must be separated");
  return Object.freeze({
    coordinatorIdentity: coordinator,
    signerIdentities: Object.freeze(signers),
    submitterIdentities: Object.freeze(submitters),
    cronosRpcOrigins: Object.freeze(independentOrigins(cronosRpcUrls, "Cronos RPC")),
    xitcoinRpcOrigins: Object.freeze(independentOrigins(xitcoinRpcUrls, "Xitcoin RPC")),
  });
}

export class RuntimeHealth {
  constructor({ workers, staleAfterSeconds = 120, now = () => Math.floor(Date.now() / 1000) }) {
    const names = identities(workers, workers?.length ?? 0, "worker names");
    if (names.length < 1) throw new Error("at least one worker is required");
    this.now = now;
    this.staleAfterSeconds = positiveInteger(staleAfterSeconds, "stale interval");
    this.startedAt = this.now();
    this.stopped = false;
    this.workers = new Map(names.map((name) => [name, { state: "starting", lastSuccessUnix: null, failures: 0 }]));
  }

  running(name) {
    const worker = this.#worker(name);
    worker.state = "running";
  }

  succeeded(name) {
    const worker = this.#worker(name);
    worker.state = "ready";
    worker.lastSuccessUnix = this.now();
  }

  failed(name) {
    const worker = this.#worker(name);
    worker.state = "failed";
    worker.failures += 1;
  }

  stop() {
    this.stopped = true;
  }

  snapshot() {
    const now = this.now();
    const workers = {};
    let ready = !this.stopped;
    for (const [name, worker] of this.workers) {
      const stale = worker.lastSuccessUnix === null || now - worker.lastSuccessUnix > this.staleAfterSeconds;
      if (worker.state === "failed" || stale) ready = false;
      workers[name] = Object.freeze({ state: worker.state, lastSuccessUnix: worker.lastSuccessUnix, failures: worker.failures, stale });
    }
    return Object.freeze({ live: !this.stopped, ready, startedAtUnix: this.startedAt, checkedAtUnix: now, workers: Object.freeze(workers) });
  }

  #worker(name) {
    const worker = this.workers.get(name);
    if (!worker) throw new Error("unknown runtime worker");
    return worker;
  }
}

export class RuntimeSupervisor {
  constructor({ workers, health }) {
    if (!Array.isArray(workers) || workers.length < 1) throw new Error("runtime workers are required");
    this.workers = workers.map((worker) => {
      const name = nonEmpty(worker?.name, "worker name");
      if (typeof worker.run !== "function") throw new Error("worker run function is required");
      return Object.freeze({ name, run: worker.run, critical: worker.critical !== false });
    });
    if (new Set(this.workers.map((worker) => worker.name)).size !== this.workers.length) throw new Error("worker names must be distinct");
    if (!(health instanceof RuntimeHealth)) throw new Error("runtime health is required");
    this.health = health;
    this.halted = false;
    this.running = false;
  }

  async runCycle() {
    if (this.halted) throw new Error("runtime is halted");
    if (this.running) throw new Error("runtime cycle is already running");
    this.running = true;
    try {
      for (const worker of this.workers) {
        this.health.running(worker.name);
        try {
          await worker.run();
          this.health.succeeded(worker.name);
        } catch (error) {
          this.health.failed(worker.name);
          if (worker.critical) {
            this.halted = true;
            throw new Error(`critical runtime worker failed: ${worker.name}`, { cause: error });
          }
        }
      }
      return this.health.snapshot();
    } finally {
      this.running = false;
    }
  }

  stop() {
    this.halted = true;
    this.health.stop();
  }
}

export function createHealthHttpHandler({ health, maximumResponseBytes = 16_384 }) {
  if (!(health instanceof RuntimeHealth)) throw new Error("runtime health is required");
  const limit = positiveInteger(maximumResponseBytes, "maximum health response size");
  return function healthHttpHandler(request, response) {
    if (request.method !== "GET" || !["/livez", "/readyz"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    const snapshot = health.snapshot();
    const success = request.url === "/livez" ? snapshot.live : snapshot.ready;
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > limit) throw new Error("health response exceeds size limit");
    response.writeHead(success ? 200 : 503, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    response.end(body);
  };
}
