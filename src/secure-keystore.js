import { timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as openDefault } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { Wallet, getAddress, isHexString } from "ethers";

function safeInteger(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function absolutePath(value, label) {
  const path = String(value ?? "");
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return path;
}

async function boundedPrivateFile({ path, label, maximumBytes, expectedOwnerUid, open }) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
    if (metadata.uid !== expectedOwnerUid) throw new Error(`${label} has an unexpected owner`);
    if (metadata.size < 1 || metadata.size > maximumBytes) throw new Error(`${label} has an invalid size`);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad`);
    const bytes = await handle.readFile();
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes) {
      throw new Error(`${label} has an invalid size`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

function credentialText(bytes, label) {
  const value = bytes.toString("utf8").replace(/\r?\n$/, "");
  if (!value || value.includes("\0") || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

async function loadBearerToken({
  credentialPath,
  expectedOwnerUid = process.geteuid(),
  maximumCredentialBytes = 4_096,
  open = openDefault,
}) {
  const credential = absolutePath(credentialPath, "transport credential path");
  if (typeof open !== "function") throw new Error("secure credential dependency is required");
  let source;
  try {
    source = await boundedPrivateFile({
      path: credential,
      label: "transport credential",
      maximumBytes: safeInteger(maximumCredentialBytes, "maximum credential size", 1),
      expectedOwnerUid: safeInteger(expectedOwnerUid, "expected owner uid"),
      open,
    });
    const token = Buffer.from(credentialText(source, "transport credential"));
    if (token.length < 32) {
      token.fill(0);
      throw new Error("transport credential is too short");
    }
    return token;
  } finally {
    source?.fill(0);
  }
}

export async function createEncryptedKeystoreDigestSigner({
  keystorePath,
  credentialPath,
  expectedAddress,
  expectedOwnerUid = process.geteuid(),
  maximumKeystoreBytes = 65_536,
  maximumCredentialBytes = 4_096,
  open = openDefault,
  decrypt = Wallet.fromEncryptedJson,
}) {
  const keystore = absolutePath(keystorePath, "keystore path");
  const credential = absolutePath(credentialPath, "credential path");
  const expected = getAddress(expectedAddress);
  if (typeof open !== "function" || typeof decrypt !== "function") {
    throw new Error("secure keystore dependencies are required");
  }
  const ownerUid = safeInteger(expectedOwnerUid, "expected owner uid");
  const keystoreLimit = safeInteger(maximumKeystoreBytes, "maximum keystore size", 1);
  const credentialLimit = safeInteger(maximumCredentialBytes, "maximum credential size", 1);
  let keystoreBytes;
  let credentialBytes;
  try {
    [keystoreBytes, credentialBytes] = await Promise.all([
      boundedPrivateFile({ path: keystore, label: "keystore", maximumBytes: keystoreLimit, expectedOwnerUid: ownerUid, open }),
      boundedPrivateFile({ path: credential, label: "credential", maximumBytes: credentialLimit, expectedOwnerUid: ownerUid, open }),
    ]);
    const wallet = await decrypt(
      keystoreBytes.toString("utf8"),
      credentialText(credentialBytes, "keystore credential"),
    );
    if (!wallet || getAddress(wallet.address) !== expected || !wallet.signingKey) {
      throw new Error("keystore does not contain the expected signer");
    }
    const signingKey = wallet.signingKey;
    return Object.freeze({
      signerAddress: expected,
      async signDigest(digest) {
        if (!isHexString(digest, 32)) throw new Error("approval digest must contain 32 bytes");
        return signingKey.sign(String(digest).toLowerCase()).serialized;
      },
    });
  } catch {
    throw new Error("signer key material could not be loaded");
  } finally {
    keystoreBytes?.fill(0);
    credentialBytes?.fill(0);
  }
}

export async function createBearerCredentialAuthorizer({
  credentialPath,
  expectedOwnerUid = process.geteuid(),
  maximumCredentialBytes = 4_096,
  open = openDefault,
}) {
  try {
    const token = await loadBearerToken({ credentialPath, expectedOwnerUid, maximumCredentialBytes, open });
    return async function authorize(request) {
      const header = String(request?.headers?.authorization ?? "");
      if (!header.startsWith("Bearer ")) return false;
      const candidate = Buffer.from(header.slice(7));
      return candidate.length === token.length && timingSafeEqual(candidate, token);
    };
  } catch {
    throw new Error("transport authorization material could not be loaded");
  }
}

export async function createBearerCredentialHeader(options) {
  try {
    const token = await loadBearerToken(options);
    return async function authorizationHeader() {
      return `Bearer ${token.toString("utf8")}`;
    };
  } catch {
    throw new Error("transport authentication material could not be loaded");
  }
}
