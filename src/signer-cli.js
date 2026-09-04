#!/usr/bin/env node
import { buildSignerRuntime, loadSignerConfig } from "./signer-bootstrap.js";

function stop(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const [configPath] = process.argv.slice(2);
  if (!configPath || process.argv.length !== 3) throw new Error("usage: signer-cli /absolute/path/to/config.json");
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (!credentialsDirectory) throw new Error("systemd credentials directory is required");
  const config = await loadSignerConfig(configPath);
  const runtime = await buildSignerRuntime(config, { credentialsDirectory });
  const shutdown = () => runtime.server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stdout.write(`${JSON.stringify({ ready: true, identity: config.identity, address: config.expectedAddress })}\n`);
}

main().catch(() => stop("signer startup failed"));
