import { createHash } from "node:crypto";

const FAULT_CODES = new Set([
  "rpc_disagreement",
  "deep_reorganization",
  "signer_offline",
  "crash_after_submission",
  "destination_pending",
  "duplicate_broadcast",
]);

function identifier(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(text)) throw new Error(`invalid ${label}`);
  return text;
}

function positiveInteger(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
  return number;
}

export class StagingFault extends Error {
  constructor(code) {
    if (!FAULT_CODES.has(code)) throw new Error("unknown staging fault code");
    super(code);
    this.name = "StagingFault";
    this.code = code;
  }
}

export class FaultPlan {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new Error("fault plan must be an array");
    this.entries = new Map();
    for (const entry of entries) {
      const point = identifier(entry?.point, "fault point");
      const code = String(entry?.code ?? "");
      if (!FAULT_CODES.has(code)) throw new Error("unknown staging fault code");
      if (this.entries.has(point)) throw new Error("duplicate staging fault point");
      this.entries.set(point, { code, remaining: positiveInteger(entry.times ?? 1, "fault count") });
    }
  }

  hit(point) {
    const key = identifier(point, "fault point");
    const fault = this.entries.get(key);
    if (!fault || fault.remaining === 0) return false;
    fault.remaining -= 1;
    throw new StagingFault(fault.code);
  }
}

export class StagingHarness {
  constructor({ scenarios, faultPlan = new FaultPlan(), now = () => Date.now() }) {
    if (!Array.isArray(scenarios) || scenarios.length < 1) throw new Error("staging scenarios are required");
    this.scenarios = scenarios.map((scenario) => {
      const name = identifier(scenario?.name, "scenario name");
      if (typeof scenario.run !== "function") throw new Error("scenario run function is required");
      return Object.freeze({ name, run: scenario.run });
    });
    if (new Set(this.scenarios.map((scenario) => scenario.name)).size !== this.scenarios.length) {
      throw new Error("staging scenario names must be distinct");
    }
    if (!(faultPlan instanceof FaultPlan)) throw new Error("fault plan is required");
    if (typeof now !== "function") throw new Error("staging clock is required");
    this.faultPlan = faultPlan;
    this.now = now;
  }

  async run() {
    const results = [];
    for (const scenario of this.scenarios) {
      const started = this.now();
      try {
        await scenario.run(Object.freeze({ faults: this.faultPlan }));
        results.push(Object.freeze({ name: scenario.name, status: "passed", durationMs: Math.max(0, this.now() - started) }));
      } catch (error) {
        const code = error instanceof StagingFault ? error.code : "scenario_failed";
        results.push(Object.freeze({ name: scenario.name, status: "failed", code, durationMs: Math.max(0, this.now() - started) }));
        break;
      }
    }
    const passed = results.length === this.scenarios.length && results.every((result) => result.status === "passed");
    const body = JSON.stringify({ version: 1, passed, results });
    return Object.freeze({ version: 1, passed, results: Object.freeze(results), reportDigest: createHash("sha256").update(body).digest("hex") });
  }
}
