import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

let checked = 0;
for (const directory of ["src", "test", "scripts"]) {
  for (const path of files(join(root, directory))) {
    // Node accepts one script for --check. Additional positional paths are
    // script arguments, so shell globs cannot check the entire source tree.
    const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      process.stderr.write(`Syntax check failed: ${relative(root, path)}\n`);
      process.exit(1);
    }
    checked++;
  }
}
process.stdout.write(`Syntax checked ${checked} JavaScript files.\n`);
