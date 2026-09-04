import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadSubmitterManifest, validateSubmitterManifest, verifySubmitterRelease } from "../src/submitter-manifest.js";
import { buildSubmitterRuntime, inspectSubmitter } from "../src/submitter-bootstrap.js";
import { runSubmitterCli } from "../src/submitter-cli.js";

const manifest = (destination = "xitcoin") => ({ version: 1, mode: "disabled", destination,
  releaseCommit: "a".repeat(40), routeId: "cronos-testnet-xitcoin-testnet", cronosChainId: 338, xitcoinChainId: "xitcoin-testnet-v2-1" });
const modulePath = `/opt/xitcoin-bridge-relayer/${"a".repeat(40)}/src/submitter-cli.js`;
const metadata = (overrides = {}) => ({ uid: 0, mode: 0o100644, size: 300, isFile: () => true, isDirectory: () => true, ...overrides });
const trustedStat = async () => metadata();

function reader(body = JSON.stringify(manifest()), properties = {}, { readError = false, chunk = 31 } = {}) {
  const bytes = Buffer.from(body);
  let offset = 0;
  const calls = { closed: 0, reads: 0, flags: undefined };
  return { calls, dependencies: { stat: trustedStat, openFile: async (_path, flags) => {
    calls.flags = flags;
    return { stat: async () => metadata({ size: bytes.length, ...properties }),
      read: async (buffer, start, length) => {
        calls.reads++;
        if (readError) throw new Error("sensitive internal detail");
        const count = Math.min(length, chunk, bytes.length - offset);
        bytes.copy(buffer, start, offset, offset + count); offset += count;
        return { bytesRead: count };
      }, close: async () => { calls.closed++; } };
  } } };
}

for (const destination of ["xitcoin", "cronos"]) {
  test(`${destination}: accepts a frozen disabled canonical manifest`, () => {
    const input = manifest(destination);
    const result = validateSubmitterManifest(input);
    input.mode = "live";
    assert.equal(result.mode, "disabled");
    assert.ok(Object.isFrozen(result));
  });
  test(`${destination}: inspection is explicitly unready and startup always refuses`, async () => {
    const options = { destination, manifestPath: "/etc/xitcoin-bridge/submitter.json", modulePath };
    const dependencies = { loadManifest: async () => manifest(destination),
      verifyRelease: (config, path) => verifySubmitterRelease(config, path, { resolve: async (x) => x, stat: trustedStat }) };
    const first = await inspectSubmitter(options, dependencies);
    assert.equal(first.ready, false);
    assert.equal(first.submissions, 0);
    assert.match(first.blocker, new RegExp(`^${destination}_`));
    assert.deepEqual(await inspectSubmitter(options, dependencies), first);
    for (let i = 0; i < 2; i++) await assert.rejects(buildSubmitterRuntime(options, dependencies), { code: "SUBMITTER_UNAVAILABLE" });
    await assert.rejects(inspectSubmitter({ ...options, destination: destination === "xitcoin" ? "cronos" : "xitcoin" }, dependencies), /does not match/);
  });
}

test("rejects unknown/missing fields, coercion, aliases, mainnet and moving releases", () => {
  const invalid = [null, [], {}, ...Object.keys(manifest()).map((field) => {
    const value = manifest(); delete value[field]; return value;
  }), ...[
    { version: "1" }, { mode: "submit" }, { mode: "dry_run" }, { destination: "Cronos" },
    { destination: "ethereum" }, { destination: "xitcoin-mainnet" }, { cronosChainId: 25 },
    { cronosChainId: "338" }, { xitcoinChainId: "xitcoin-mainnet" }, { routeId: "other" },
    { releaseCommit: "main" }, { releaseCommit: "A".repeat(40) }, { releaseCommit: "a".repeat(39) },
    { rpcUrls: [] }, { credentials: {} }, { adapter: "private.mjs" }, { statePath: "/tmp/state" },
  ].map((patch) => ({ ...manifest(), ...patch }))];
  for (const input of invalid) assert.throws(() => validateSubmitterManifest(input));
});

test("root manifest loader bounds reads, rejects symlinks, and closes the descriptor", async () => {
  const { calls, dependencies } = reader();
  assert.deepEqual(await loadSubmitterManifest("/etc/bridge/submitter.json", dependencies), manifest());
  assert.equal(calls.closed, 1);
  assert.ok(calls.reads > 1);
  assert.ok(calls.flags & constants.O_NOFOLLOW);
  assert.ok(calls.flags & constants.O_NONBLOCK);
});

test("rejects unsafe metadata before reading and sanitizes every failure", async () => {
  for (const properties of [{ uid: 1000 }, { mode: 0o100664 }, { mode: 0o100646 },
    { isFile: () => false }, { size: 0 }, { size: 16_385 }]) {
    const { calls, dependencies } = reader(undefined, properties);
    await assert.rejects(loadSubmitterManifest("/etc/bridge/submitter.json", dependencies), { message: "submitter manifest could not be loaded" });
    assert.equal(calls.reads, 0);
    assert.equal(calls.closed, 1);
  }
  for (const body of ["{invalid", "null", Buffer.from([0xff]), " ".repeat(16_385)]) {
    const { calls, dependencies } = reader(body, { size: 1 });
    await assert.rejects(loadSubmitterManifest("/etc/bridge/submitter.json", dependencies), /could not be loaded/);
    assert.equal(calls.closed, 1);
  }
  const { calls, dependencies } = reader(undefined, {}, { readError: true });
  await assert.rejects(loadSubmitterManifest("/etc/bridge/submitter.json", dependencies), { message: "submitter manifest could not be loaded" });
  assert.equal(calls.closed, 1);
});

test("rejects relative, unnormalized and untrusted ancestor paths before opening", async () => {
  for (const path of ["relative.json", "/etc/../tmp/config", "/etc//config", "/etc/./config", "/etc/config\0"]) {
    await assert.rejects(loadSubmitterManifest(path, { openFile: () => assert.fail("opened"), stat: trustedStat }));
  }
  for (const properties of [{ uid: 1000 }, { mode: 0o40777 }, { isDirectory: () => false }]) {
    await assert.rejects(loadSubmitterManifest("/etc/bridge/config", {
      openFile: () => assert.fail("opened"), stat: async () => metadata(properties),
    }));
  }
});

test("real filesystem rejects a symlink manifest and a writable parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "submitter-test-"));
  try {
    const path = join(directory, "manifest.json");
    await writeFile(path, JSON.stringify(manifest()));
    await symlink(path, join(directory, "link.json"));
    await assert.rejects(loadSubmitterManifest(join(directory, "link.json"), { stat: trustedStat }));
    await assert.rejects(loadSubmitterManifest(path)); // /tmp is writable, even for a root-owned fixture.
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("release resolves current to the pinned root-owned immutable layout", async () => {
  assert.equal(await verifySubmitterRelease(manifest(), "/opt/xitcoin-bridge-relayer/current/src/submitter-cli.js", {
    resolve: async () => modulePath, stat: trustedStat,
  }), manifest().releaseCommit);
  for (const path of [modulePath.replace("a".repeat(40), "b".repeat(40)),
    modulePath.replace("a".repeat(40), "current"), modulePath.replace("/opt/", "/tmp/"),
    modulePath.replace("submitter-cli.js", "other.js")]) {
    await assert.rejects(verifySubmitterRelease(manifest(), path, { resolve: async (x) => x, stat: trustedStat }));
  }
  for (const properties of [{ uid: 1000 }, { mode: 0o100666 }, { isFile: () => false }]) {
    await assert.rejects(verifySubmitterRelease(manifest(), modulePath, {
      resolve: async (x) => x, stat: async (path) => path === modulePath ? metadata(properties) : metadata(),
    }));
  }
  await assert.rejects(verifySubmitterRelease(manifest(), modulePath, {
    resolve: async (x) => x, stat: async () => metadata({ mode: 0o40777 }),
  }));
});

test("CLI checks are distinct from startup and failures disclose no supplied input", async () => {
  let output = "", errors = "", builds = 0;
  const dependencies = { stdout: { write: (x) => { output += x; } }, stderr: { write: (x) => { errors += x; } },
    inspect: async () => ({ ready: false, submissions: 0 }), build: async () => { builds++; throw new Error("sensitive detail"); } };
  assert.equal(await runSubmitterCli(["check", "cronos", "/etc/config"], dependencies), 0);
  assert.deepEqual(JSON.parse(output), { ready: false, submissions: 0 });
  assert.equal(builds, 0);
  assert.equal(await runSubmitterCli(["start", "cronos", "/etc/config"], dependencies), 1);
  assert.equal(builds, 1);
  for (const args of [[], ["check", "mainnet", "/secret/path"], ["start", "cronos", "/etc/config", "extra"]]) {
    assert.equal(await runSubmitterCli(args, dependencies), 1);
  }
  assert.doesNotMatch(errors, /sensitive detail|secret\/path/);
});

test("public CLI executes both directly and via a release-style symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "submitter-cli-"));
  try {
    const cli = new URL("../src/submitter-cli.js", import.meta.url);
    const linked = join(directory, "submitter.mjs");
    await symlink(cli, linked);
    for (const path of [cli.pathname, linked]) {
      const result = spawnSync(process.execPath, [path, "start", "cronos", "/nonexistent/manifest.json"], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /submitter stopped/);
      assert.doesNotMatch(result.stderr, /nonexistent/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("systemd phase one uses public CLI, denies networking and does not restart", async () => {
  const unit = await readFile(new URL("../ops/systemd/xitcoin-bridge-submitter@.service", import.meta.url), "utf8");
  assert.match(unit, /src\/submitter-cli.js start %i \/etc\/xitcoin-bridge\/submitter-%i.json/);
  assert.match(unit, /^Restart=no$/m);
  assert.match(unit, /^IPAddressDeny=any$/m);
  assert.match(unit, /^LimitCORE=0$/m);
  assert.doesNotMatch(unit, /LoadCredential|ReadWritePaths|submitter.mjs/);
});


test("manifest traversal rejects higher unsafe ancestors after a trusted parent", async () => {
  for (const ancestor of ["/etc", "/"]) {
    for (const properties of [{ uid: 1000 }, { mode: 0o40775 }, { mode: 0o40757 },
      { isDirectory: () => false, isSymbolicLink: () => true }]) {
      const visited = [];
      await assert.rejects(loadSubmitterManifest("/etc/bridge/config", {
        openFile: () => assert.fail("opened before ancestor validation"),
        stat: async (path) => { visited.push(path); return metadata(path === ancestor ? properties : {}); },
      }), { message: "submitter manifest could not be loaded" });
      assert.deepEqual(visited, ancestor === "/etc" ? ["/etc/bridge", "/etc"] : ["/etc/bridge", "/etc", "/"]);
    }
  }
});

test("release traversal rejects every higher unsafe ancestor after a trusted src parent", async () => {
  const parents = [modulePath.slice(0, -"/submitter-cli.js".length),
    `/opt/xitcoin-bridge-relayer/${"a".repeat(40)}`, "/opt/xitcoin-bridge-relayer", "/opt", "/"];
  for (const ancestor of parents.slice(1)) {
    for (const properties of [{ uid: 1000 }, { mode: 0o40775 }, { mode: 0o40757 },
      { isDirectory: () => false, isSymbolicLink: () => true }]) {
      const visited = [];
      await assert.rejects(verifySubmitterRelease(manifest(), modulePath, {
        resolve: async (path) => path,
        stat: async (path) => { visited.push(path); return metadata(path === ancestor ? properties : {}); },
      }), /unsafe parent directory/);
      assert.deepEqual(visited, parents.slice(0, parents.indexOf(ancestor) + 1));
    }
  }
});
