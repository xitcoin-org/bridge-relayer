#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSubmitterRuntime, inspectSubmitter } from "./submitter-bootstrap.js";

export async function runSubmitterCli(args, { modulePath = fileURLToPath(import.meta.url),
  inspect = inspectSubmitter, build = buildSubmitterRuntime,
  stdout = process.stdout, stderr = process.stderr,
} = {}) {
  try {
    const [action, destination, manifestPath] = args;
    if (args.length !== 3 || !["check", "start"].includes(action) || !["xitcoin", "cronos"].includes(destination)) {
      throw new Error("invalid arguments");
    }
    const options = { destination, manifestPath, modulePath };
    if (action === "start") await build(options);
    else stdout.write(`${JSON.stringify(await inspect(options))}\n`);
    return 0;
  } catch {
    stderr.write("submitter stopped: invalid configuration, release, or unavailable destination adapter; see docs/SUBMITTERS.md\n");
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSubmitterCli(process.argv.slice(2));
}
