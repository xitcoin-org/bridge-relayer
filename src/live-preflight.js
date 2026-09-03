import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { Contract, getAddress } from "ethers";

import {
  CometBftHttpClient,
  connectCronosProviders,
  decodeXitcoinOutboundBlock,
  decodeXitcoinOutboundTransaction,
} from "./network.js";

const execFile = promisify(execFileCallback);

const VAULT_ABI = Object.freeze([
  "function paused() view returns (bool)",
  "function routeId() view returns (bytes32)",
  "function asset() view returns (address)",
  "function guardian() view returns (address)",
  "function signerSetVersion() view returns (uint256)",
  "function signers() view returns (address[3])",
  "function maxReleaseAmount() view returns (uint256)",
  "function dailyReleaseLimit() view returns (uint256)",
]);

function modeBits(value) {
  return Number(value) & 0o777;
}

function parsePasswd(record, identity) {
  const fields = String(record).trim().split(":");
  if (fields.length < 7 || fields[0] !== identity) throw new Error("identity record is invalid");
  const shell = fields[6];
  return {
    exists: true,
    locked: fields[1] === "!" || fields[1] === "*" || fields[1] === "x",
    interactive: !["/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false"].includes(shell),
  };
}

export function createHostInspectors({ exec = execFile, statPath = stat, readPasswd = () => readFile("/etc/passwd", "utf8") } = {}) {
  return Object.freeze({
    async inspectIdentity(identity) {
      try {
        const passwd = await readPasswd();
        const record = passwd.split("\n").find((line) => line.startsWith(`${identity}:`));
        if (!record) return { exists: false, locked: false, interactive: false };
        const result = parsePasswd(record, identity);
        const { stdout } = await exec("passwd", ["-S", identity], { encoding: "utf8" });
        const state = stdout.trim().split(/\s+/)[1];
        return { ...result, locked: result.locked && ["L", "LK"].includes(state) };
      } catch {
        return { exists: false, locked: false, interactive: false };
      }
    },

    async inspectPath(path) {
      try {
        const details = await statPath(path);
        const { stdout } = await exec("id", ["-un", String(details.uid)], { encoding: "utf8" });
        return {
          exists: true,
          type: details.isDirectory() ? "directory" : details.isFile() ? "file" : "other",
          owner: stdout.trim(),
          mode: modeBits(details.mode),
        };
      } catch {
        return { exists: false, type: "missing", owner: null, mode: 0 };
      }
    },

    async inspectService(name) {
      const unit = `xitcoin-bridge-${name}.service`;
      const check = async (verb) => {
        try {
          const { stdout } = await exec("systemctl", [verb, unit], { encoding: "utf8" });
          return stdout.trim();
        } catch (error) {
          return String(error?.stdout ?? "").trim();
        }
      };
      const [active, enabled] = await Promise.all([check("is-active"), check("is-enabled")]);
      return { active: active === "active", enabled: enabled === "enabled" };
    },
  });
}

function normalizeVault(snapshot) {
  return {
    ...snapshot,
    address: getAddress(snapshot.address),
    asset: getAddress(snapshot.asset),
    guardian: getAddress(snapshot.guardian),
    signers: snapshot.signers.map(getAddress),
    routeId: String(snapshot.routeId).toLowerCase(),
    signerSetVersion: String(snapshot.signerSetVersion),
    maxReleaseAmount: String(snapshot.maxReleaseAmount),
    dailyReleaseLimit: String(snapshot.dailyReleaseLimit),
  };
}

async function readVault(provider, address, contractFactory) {
  const code = await provider.getCode(address);
  const vault = contractFactory(address, VAULT_ABI, provider);
  const [paused, routeId, asset, guardian, signerSetVersion, signers, maxReleaseAmount, dailyReleaseLimit] =
    await Promise.all([
      vault.paused(), vault.routeId(), vault.asset(), vault.guardian(), vault.signerSetVersion(),
      vault.signers(), vault.maxReleaseAmount(), vault.dailyReleaseLimit(),
    ]);
  return normalizeVault({ codePresent: code !== "0x", address, paused, routeId, asset, guardian,
    signerSetVersion, signers: [...signers], maxReleaseAmount, dailyReleaseLimit });
}

function canonical(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

export function createLiveNetworkProbe(manifest, {
  connectCronos = connectCronosProviders,
  contractFactory = (...args) => new Contract(...args),
  xitcoinClientFactory = (url) => new CometBftHttpClient({
    url,
    chainId: manifest.xitcoinChainId,
    decodeBlock: decodeXitcoinOutboundBlock,
    decodeTransaction: decodeXitcoinOutboundTransaction,
    allowHttp: manifest.allowLoopbackHttp === true,
  }),
} = {}) {
  return async function probeNetwork(network) {
    if (network === "cronos") {
      const providers = await connectCronos({
        urls: manifest.cronosRpcUrls,
        chainId: Number(manifest.cronosChainId),
        allowHttp: manifest.allowLoopbackHttp === true,
      });
      const snapshots = await Promise.all(providers.map((provider) =>
        readVault(provider, manifest.cronosVaultAddress, contractFactory)));
      if (new Set(snapshots.map(canonical)).size !== 1) throw new Error("Cronos RPC disagreement");
      return { independent: providers.length >= 2, chainId: manifest.cronosChainId, catchingUp: false, vault: snapshots[0] };
    }
    if (network === "xitcoin") {
      const clients = manifest.xitcoinRpcUrls.map(xitcoinClientFactory);
      const statuses = await Promise.all(clients.map((client) => client.status()));
      if (statuses.some((status) => status.chainId !== manifest.xitcoinChainId)) throw new Error("Xitcoin RPC disagreement");
      return { independent: clients.length >= 2, chainId: manifest.xitcoinChainId, catchingUp: false };
    }
    throw new Error("unknown network probe");
  };
}

export { VAULT_ABI };
