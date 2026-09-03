#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createHostInspectors, createLiveNetworkProbe } from "./live-preflight.js";
import { TestnetPreflight, validatePreflightManifest } from "./preflight.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const [manifestArgument] = process.argv.slice(2);
  if (!manifestArgument) throw new Error("usage: npm run preflight:testnet -- /absolute/path/to/manifest.json");
  const manifestPath = resolve(manifestArgument);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validatePreflightManifest(manifest);
  const inspectors = createHostInspectors();
  const preflight = new TestnetPreflight({
    manifest,
    ...inspectors,
    probeNetwork: createLiveNetworkProbe(manifest),
  });
  const report = await preflight.run();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => fail(`preflight failed: ${error?.message ?? error}`));
