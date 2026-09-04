#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildApprovalOnlyCoordinator, loadCoordinatorConfig, verifyCoordinatorRelease } from "./coordinator-bootstrap.js";

async function main() {
  const [configPath] = process.argv.slice(2);
  if (!configPath || process.argv.length !== 3) throw new Error("usage: coordinator-cli /absolute/path/to/config.json");
  if (!process.env.CREDENTIALS_DIRECTORY) throw new Error("systemd credentials directory is required");
  const config = await loadCoordinatorConfig(configPath);
  verifyCoordinatorRelease(config, fileURLToPath(import.meta.url));
  const runtime = await buildApprovalOnlyCoordinator(config, { credentialsDirectory: process.env.CREDENTIALS_DIRECTORY });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(`${JSON.stringify({ ready: true, mode: "approval_only", releaseCommit: config.releaseCommit })}\n`);
  try {
    while (!stopping) {
      const report = await runtime.runOnce();
      process.stdout.write(`${JSON.stringify({ mode: report.mode, approved: report.approved, submissions: 0 })}\n`);
      if (!stopping) await delay(config.cycleIntervalMs);
    }
  } finally {
    runtime.close();
  }
}

main().catch(() => { process.stderr.write("approval-only coordinator stopped\n"); process.exitCode = 1; });
