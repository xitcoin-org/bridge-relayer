import { loadSubmitterManifest, verifySubmitterRelease } from "./submitter-manifest.js";

export const SUBMITTER_GAPS = Object.freeze({
  xitcoin: "xitcoin_canonical_transaction_and_status_adapter_missing",
  cronos: "cronos_durable_broadcast_and_confirmation_adapter_missing",
});

// No store, RPC, credential, signing or broadcast dependencies are reachable here.
export async function inspectSubmitter({ manifestPath, destination, modulePath }, {
  loadManifest = loadSubmitterManifest, verifyRelease = verifySubmitterRelease,
} = {}) {
  const manifest = await loadManifest(manifestPath);
  // Verification revalidates the complete manifest, including disabled mode.
  await verifyRelease(manifest, modulePath);
  if (destination !== manifest.destination) throw new Error("submitter destination does not match its manifest");
  return Object.freeze({ version: 1, destination: manifest.destination, releaseCommit: manifest.releaseCommit,
    mode: "disabled", ready: false, submissions: 0, blocker: SUBMITTER_GAPS[manifest.destination] });
}

export async function buildSubmitterRuntime(options, dependencies) {
  const report = await inspectSubmitter(options, dependencies);
  const error = new Error(report.blocker);
  error.code = "SUBMITTER_UNAVAILABLE";
  throw error;
}
