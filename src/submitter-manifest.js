import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

const FIELDS = ["version", "mode", "destination", "releaseCommit", "routeId", "cronosChainId", "xitcoinChainId"];
const MAX_BYTES = 16_384;

function absolute(path) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
    throw new Error("path must be absolute and normalized");
  }
  return path;
}

export function validateSubmitterManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== FIELDS.length
      || Object.keys(input).some((key) => !FIELDS.includes(key))) throw new Error("unsupported submitter manifest fields");
  if (input.version !== 1 || input.mode !== "disabled") throw new Error("only disabled phase-one submitters are supported");
  if (!["xitcoin", "cronos"].includes(input.destination)) throw new Error("destination is not canonical");
  if (typeof input.releaseCommit !== "string" || !/^[0-9a-f]{40}$/.test(input.releaseCommit)) throw new Error("release must be an immutable Git commit");
  if (input.routeId !== "cronos-testnet-xitcoin-testnet" || input.cronosChainId !== 338
      || input.xitcoinChainId !== "xitcoin-testnet-v2-1") throw new Error("only the canonical testnet route is supported");
  return Object.freeze(Object.fromEntries(FIELDS.map((key) => [key, input[key]])));
}

// Trust root, but never a service-writable ancestor or a symlink in the manifest path.
async function trustedParents(path, stat) {
  let parent = dirname(path);
  while (true) {
    const metadata = await stat(parent);
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw new Error("unsafe parent directory");
    if (parent === "/") break;
    parent = dirname(parent);
  }
}

export async function loadSubmitterManifest(path, { openFile = open, stat = lstat } = {}) {
  let handle;
  try {
    absolute(path);
    await trustedParents(path, stat);
    handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022)
        || metadata.size < 1 || metadata.size > MAX_BYTES) throw new Error("unsafe manifest");
    // Bound the actual read even if a root-owned file changes after fstat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!length || length > MAX_BYTES) throw new Error("invalid manifest size");
    return validateSubmitterManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
  } catch {
    throw new Error("submitter manifest could not be loaded");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function verifySubmitterRelease(config, modulePath, { resolve = realpath, stat = lstat } = {}) {
  const manifest = validateSubmitterManifest(config);
  const resolved = absolute(await resolve(absolute(modulePath)));
  const expected = `/opt/xitcoin-bridge-relayer/${manifest.releaseCommit}/src/submitter-cli.js`;
  if (resolved !== expected) throw new Error("submitter release does not match its pinned manifest");
  await trustedParents(resolved, stat);
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw new Error("unsafe submitter release");
  return manifest.releaseCommit;
}
