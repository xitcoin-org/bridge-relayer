import assert from "node:assert/strict";
import test from "node:test";

import { SigningKey, computeAddress, encryptKeystoreJsonSync, recoverAddress } from "ethers";

import { createBearerCredentialAuthorizer, createEncryptedKeystoreDigestSigner } from "../src/secure-keystore.js";

const KEY = new SigningKey(`0x${"31".repeat(32)}`);
const ADDRESS = computeAddress(KEY.publicKey);
const DIGEST = `0x${"ab".repeat(32)}`;

function privateStat(size, mode = 0o100600) {
  return { size, mode, isFile: () => true };
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
    readFile: async (path) => Buffer.from(files.get(path)),
    stat: async (path) => privateStat(files.get(path).length),
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
    readFile: async (path) => Buffer.from(files.get(path)),
    stat: async (path) => privateStat(files.get(path).length),
  });
  assert.equal(recoverAddress(DIGEST, await signer.signDigest(DIGEST)), ADDRESS);
});

test("rejects wrong accounts, broad permissions, oversized files and relative paths without leaking details", async () => {
  const bytes = Buffer.from("private material");
  const options = {
    keystorePath: "/keys/signer.json",
    credentialPath: "/run/credentials/keystore-password",
    expectedAddress: ADDRESS,
    readFile: async () => Buffer.from(bytes),
    stat: async () => privateStat(bytes.length),
    decrypt: async () => ({ address: computeAddress(new SigningKey(`0x${"32".repeat(32)}`).publicKey), signingKey: KEY }),
  };
  await assert.rejects(() => createEncryptedKeystoreDigestSigner(options), (error) => {
    assert.equal(error.message, "signer key material could not be loaded");
    assert.doesNotMatch(error.message, /private material|expected signer/i);
    return true;
  });
  await assert.rejects(() => createEncryptedKeystoreDigestSigner({ ...options, stat: async () => privateStat(bytes.length, 0o100644) }), /could not be loaded/);
  await assert.rejects(() => createEncryptedKeystoreDigestSigner({ ...options, maximumKeystoreBytes: 4 }), /could not be loaded/);
  await assert.rejects(() => createEncryptedKeystoreDigestSigner({ ...options, keystorePath: "relative.json" }), /absolute path/);
});

test("authorizes a constant-time bearer credential without exposing it", async () => {
  const secret = "t".repeat(48);
  const source = Buffer.from(`${secret}\n`);
  const authorize = await createBearerCredentialAuthorizer({
    credentialPath: "/run/credentials/transport-token",
    readFile: async () => Buffer.from(source),
    stat: async () => privateStat(source.length),
  });
  assert.equal(await authorize({ headers: { authorization: `Bearer ${secret}` } }), true);
  assert.equal(await authorize({ headers: { authorization: `Bearer ${"x".repeat(48)}` } }), false);
  assert.equal(await authorize({ headers: {} }), false);
});

test("rejects short or broadly readable transport credentials", async () => {
  const source = Buffer.from("too-short");
  const base = {
    credentialPath: "/run/credentials/transport-token",
    readFile: async () => Buffer.from(source),
    stat: async () => privateStat(source.length),
  };
  await assert.rejects(() => createBearerCredentialAuthorizer(base), /could not be loaded/);
  await assert.rejects(() => createBearerCredentialAuthorizer({ ...base, stat: async () => privateStat(source.length, 0o100640) }), /could not be loaded/);
});
