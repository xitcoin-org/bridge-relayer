import assert from "node:assert/strict";
import test from "node:test";

import { SigningKey, computeAddress, encryptKeystoreJsonSync, recoverAddress } from "ethers";

import { createBearerCredentialAuthorizer, createBearerCredentialHeader, createEncryptedKeystoreDigestSigner } from "../src/secure-keystore.js";

const KEY = new SigningKey(`0x${"31".repeat(32)}`);
const ADDRESS = computeAddress(KEY.publicKey);
const DIGEST = `0x${"ab".repeat(32)}`;
const OWNER_UID = process.geteuid();

function privateStat(size, mode = 0o100600, uid = OWNER_UID) {
  return { size, mode, uid, isFile: () => true };
}

function mockOpen(files, { mode = 0o100600, uid = OWNER_UID } = {}) {
  return async (path, flags) => {
    const source = files.get(path);
    if (!source) throw new Error("missing fixture");
    return {
      async stat() { return privateStat(source.length, mode, uid); },
      async readFile() { return Buffer.from(source); },
      async close() {},
      flags,
    };
  };
}

function mockOpenOwners(files, owners, mode = 0o100600) {
  return async (path, flags) => {
    const source = files.get(path);
    if (!source) throw new Error("missing fixture");
    return {
      async stat() { return privateStat(source.length, mode, owners.get(path)); },
      async readFile() { return Buffer.from(source); },
      async close() {},
      flags,
    };
  };
}

test("loads bounded private key material and signs only with the expected account", async () => {
  const files = new Map([
    ["/keys/signer.json", Buffer.from('{"encrypted":true}')],
    ["/run/credentials/keystore-password", Buffer.from("correct horse battery staple\n")],
  ]);
  const signer = await createEncryptedKeystoreDigestSigner({
    keystorePath: "/keys/signer.json",
    credentialPath: "/run/credentials/keystore-password",
    expectedAddress: ADDRESS,
    open: mockOpen(files),
    decrypt: async (json, password) => {
      assert.equal(json, '{"encrypted":true}');
      assert.equal(password, "correct horse battery staple");
      return { address: ADDRESS, signingKey: KEY };
    },
  });
  const signature = await signer.signDigest(DIGEST);
  assert.equal(recoverAddress(DIGEST, signature), ADDRESS);
  await assert.rejects(() => signer.signDigest("0x12"), /32 bytes/);
});

test("decrypts a real Web3 keystore through the default adapter", async () => {
  const password = "integration-test-password";
  const json = encryptKeystoreJsonSync(
    { address: ADDRESS, privateKey: KEY.privateKey },
    password,
    { scrypt: { N: 1024, r: 8, p: 1 } },
  );
  const files = new Map([
    ["/keys/signer.json", Buffer.from(json)],
    ["/run/credentials/keystore-password", Buffer.from(password)],
  ]);
  const signer = await createEncryptedKeystoreDigestSigner({
    keystorePath: "/keys/signer.json",
    credentialPath: "/run/credentials/keystore-password",
    expectedAddress: ADDRESS,
    open: mockOpen(files),
  });
  assert.equal(recoverAddress(DIGEST, await signer.signDigest(DIGEST)), ADDRESS);
});

test("accepts a service-owned keystore with a root-owned systemd credential", async () => {
  const serviceUid = 1001;
  const keystorePath = "/keys/signer.json";
  const credentialPath = "/run/credentials/keystore-password";
  const files = new Map([
    [keystorePath, Buffer.from('{"encrypted":true}')],
    [credentialPath, Buffer.from("host-bound-password")],
  ]);
  const signer = await createEncryptedKeystoreDigestSigner({
    keystorePath,
    credentialPath,
    expectedAddress: ADDRESS,
    expectedOwnerUid: serviceUid,
    open: mockOpenOwners(files, new Map([[keystorePath, serviceUid], [credentialPath, 0]])),
    decrypt: async () => ({ address: ADDRESS, signingKey: KEY }),
  });
  assert.equal(signer.signerAddress, ADDRESS);
});

test("accepts only a root-owned systemd bearer credential by default", async () => {
  const path = "/run/credentials/transport-token";
  const token = "r".repeat(48);
  const files = new Map([[path, Buffer.from(token)]]);
  const authorize = await createBearerCredentialAuthorizer({
    credentialPath: path,
    open: mockOpen(files, { uid: 0 }),
  });
  assert.equal(await authorize({ headers: { authorization: `Bearer ${token}` } }), true);
  await assert.rejects(
    () => createBearerCredentialAuthorizer({ credentialPath: path, open: mockOpen(files, { uid: 1001 }) }),
    /could not be loaded/,
  );
});

test("rejects wrong accounts, broad permissions, oversized files and relative paths without leaking details", async () => {
  const bytes = Buffer.from("private material");
  const files = new Map([
    ["/keys/signer.json", bytes],
    ["/run/credentials/keystore-password", bytes],
  ]);
  const options = {
    keystorePath: "/keys/signer.json",
    credentialPath: "/run/credentials/keystore-password",
    expectedAddress: ADDRESS,
    open: mockOpen(files),
    decrypt: async () => ({ address: computeAddress(new SigningKey(`0x${"32".repeat(32)}`).publicKey), signingKey: KEY }),
  };
  await assert.rejects(() => createEncryptedKeystoreDigestSigner(options), (error) => {
    assert.equal(error.message, "signer key material could not be loaded");
    assert.doesNotMatch(error.message, /private material|expected signer/i);
    return true;
  });
  await assert.rejects(() => createEncryptedKeystoreDigestSigner({ ...options, open: mockOpen(files, { mode: 0o100644 }) }), /could not be loaded/);
  await assert.rejects(() => createEncryptedKeystoreDigestSigner({ ...options, maximumKeystoreBytes: 4 }), /could not be loaded/);
  await assert.rejects(() => createEncryptedKeystoreDigestSigner({ ...options, keystorePath: "relative.json" }), /absolute path/);
});

test("rejects unexpected owners and symbolic links without exposing their paths", async () => {
  const source = Buffer.from("private material");
  const files = new Map([
    ["/keys/signer.json", source],
    ["/run/credentials/keystore-password", source],
  ]);
  const base = {
    keystorePath: "/keys/signer.json",
    credentialPath: "/run/credentials/keystore-password",
    expectedAddress: ADDRESS,
    decrypt: async () => ({ address: ADDRESS, signingKey: KEY }),
  };
  await assert.rejects(
    () => createEncryptedKeystoreDigestSigner({ ...base, open: mockOpen(files, { uid: OWNER_UID + 1 }) }),
    /could not be loaded/,
  );
  const symbolicLinkOpen = async () => {
    const error = new Error("refused symbolic link /secret/path");
    error.code = "ELOOP";
    throw error;
  };
  await assert.rejects(
    () => createEncryptedKeystoreDigestSigner({ ...base, open: symbolicLinkOpen }),
    (error) => error.message === "signer key material could not be loaded" && !error.message.includes("/secret/path"),
  );
});

test("authorizes a constant-time bearer credential without exposing it", async () => {
  const secret = "t".repeat(48);
  const source = Buffer.from(`${secret}\n`);
  const files = new Map([["/run/credentials/transport-token", source]]);
  const authorize = await createBearerCredentialAuthorizer({
    credentialPath: "/run/credentials/transport-token",
    open: mockOpen(files),
  });
  assert.equal(await authorize({ headers: { authorization: `Bearer ${secret}` } }), true);
  assert.equal(await authorize({ headers: { authorization: `Bearer ${"x".repeat(48)}` } }), false);
  assert.equal(await authorize({ headers: {} }), false);
});

test("loads a bounded bearer header for an authenticated coordinator client", async () => {
  const token = "c".repeat(32);
  const path = "/run/credentials/signer-1-transport-token";
  const authorizationHeader = await createBearerCredentialHeader({
    credentialPath: path,
    expectedOwnerUid: 1001,
    open: mockOpen(new Map([[path, Buffer.from(token)]]), { uid: 1001, mode: 0o100400 }),
  });
  assert.equal(await authorizationHeader(), `Bearer ${token}`);
});

test("rejects short, broadly readable or wrongly owned transport credentials", async () => {
  const source = Buffer.from("too-short");
  const files = new Map([["/run/credentials/transport-token", source]]);
  const base = {
    credentialPath: "/run/credentials/transport-token",
    open: mockOpen(files),
  };
  await assert.rejects(() => createBearerCredentialAuthorizer(base), /could not be loaded/);
  await assert.rejects(
    () => createBearerCredentialAuthorizer({ ...base, open: mockOpen(files, { mode: 0o100640 }) }),
    /could not be loaded/,
  );
  await assert.rejects(
    () => createBearerCredentialAuthorizer({ ...base, open: mockOpen(files, { uid: OWNER_UID + 1 }) }),
    /could not be loaded/,
  );
});
