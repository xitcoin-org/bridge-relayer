import { timingSafeEqual } from "node:crypto";
import { readFile as readFileDefault, stat as statDefault } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { Wallet, getAddress, isHexString } from "ethers";

function positiveInteger(value, label, minimum = 1) {
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

async function boundedPrivateFile({ path, label, maximumBytes, readFile, stat }) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (metadata.size < 1 || metadata.size > maximumBytes) throw new Error(`${label} has an invalid size`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad`);
  const bytes = await readFile(path);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }
  return bytes;
}

function credentialText(bytes, label) {
  const value = bytes.toString("utf8").replace(/\r?\n$/, "");
  if (!value || value.includes("\0") || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export async function createEncryptedKeystoreDigestSigner({
  keystorePath,
  credentialPath,
  expectedAddress,
  maximumKeystoreBytes = 65_536,
  maximumCredentialBytes = 4_096,
  readFile = readFileDefault,
  stat = statDefault,
  decrypt = Wallet.fromEncryptedJson,
}) {
  const keystore = absolutePath(keystorePath, "keystore path");
  const credential = absolutePath(credentialPath, "credential path");
  const expected = getAddress(expectedAddress);
  if (typeof readFile !== "function" || typeof stat !== "function" || typeof decrypt !== "function") {
    throw new Error("secure keystore dependencies are required");
  }
  const keystoreLimit = positiveInteger(maximumKeystoreBytes, "maximum keystore size");
  const credentialLimit = positiveInteger(maximumCredentialBytes, "maximum credential size");
  let keystoreBytes;
  let credentialBytes;
  try {
    [keystoreBytes, credentialBytes] = await Promise.all([
      boundedPrivateFile({ path: keystore, label: "keystore", maximumBytes: keystoreLimit, readFile, stat }),
      boundedPrivateFile({ path: credential, label: "credential", maximumBytes: credentialLimit, readFile, stat }),
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
  maximumCredentialBytes = 4_096,
  readFile = readFileDefault,
  stat = statDefault,
}) {
  const credential = absolutePath(credentialPath, "transport credential path");
  let source;
  try {
    source = await boundedPrivateFile({
      path: credential,
      label: "transport credential",
      maximumBytes: positiveInteger(maximumCredentialBytes, "maximum credential size"),
      readFile,
      stat,
    });
    const token = Buffer.from(credentialText(source, "transport credential"));
    if (token.length < 32) throw new Error("transport credential is too short");
    return async function authorize(request) {
      const header = String(request?.headers?.authorization ?? "");
      if (!header.startsWith("Bearer ")) return false;
      const candidate = Buffer.from(header.slice(7));
      return candidate.length === token.length && timingSafeEqual(candidate, token);
    };
  } catch {
    throw new Error("transport authorization material could not be loaded");
  } finally {
    source?.fill(0);
  }
}
