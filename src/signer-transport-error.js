const messages = Object.freeze({
  AUTHENTICATION: "signer transport authentication is invalid",
  TRANSPORT: "signer transport failed",
  TIMEOUT: "signer request timed out",
  HTTP: "signer returned HTTP failure",
  SIZE: "signer response exceeds size limit",
  LENGTH: "signer response exceeds size limit or has invalid content length",
  STREAM: "signer response requires a readable byte stream",
  ENCODING: "signer response contains invalid UTF-8 encoded data",
  JSON: "signer returned invalid JSON",
});
const categories = new WeakMap();

export function signerTransportError(category) {
  const error = new Error(messages[category]);
  delete error.stack;
  Object.defineProperty(error, "code", { value: `SIGNER_${category}`, enumerable: true });
  categories.set(error, category);
  return Object.freeze(error);
}

// Never inspect untrusted errors, including getters, causes or spoofed codes.
// Reconstruct even trusted errors so only our fixed public vocabulary escapes.
export function sanitizeSignerTransportError(error) {
  return signerTransportError(categories.get(error) ?? "TRANSPORT");
}
