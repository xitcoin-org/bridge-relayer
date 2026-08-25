const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function hrpExpand(prefix) {
  return [
    ...Array.from(prefix, character => character.charCodeAt(0) >>> 5),
    0,
    ...Array.from(prefix, character => character.charCodeAt(0) & 31),
  ];
}

function convertBits(data, from, to, pad) {
  let accumulator = 0;
  let bits = 0;
  const result = [];
  const maxValue = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >>> from !== 0) throw new Error("invalid address byte");
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((accumulator >>> bits) & maxValue);
    }
  }
  if (pad && bits > 0) result.push((accumulator << (to - bits)) & maxValue);
  if (!pad && (bits >= from || ((accumulator << (to - bits)) & maxValue))) {
    throw new Error("invalid address padding");
  }
  return result;
}

export function bech32Encode(prefix, bytes) {
  if (!/^[a-z0-9]{1,83}$/.test(prefix)) throw new Error("invalid Bech32 prefix");
  const words = convertBits(bytes, 8, 5, true);
  const values = [...hrpExpand(prefix), ...words, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(values) ^ 1;
  const suffix = Array.from({ length: 6 }, (_, index) =>
    CHARSET[(checksum >>> (5 * (5 - index))) & 31]);
  return `${prefix}1${words.map(word => CHARSET[word]).join("")}${suffix.join("")}`;
}

export function evmAddressToBech32(address, prefix = "xtc") {
  const normalized = String(address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error("invalid EVM address");
  if (/^0x0{40}$/.test(normalized) || normalized === "0x000000000000000000000000000000000000dead") {
    throw new Error("invalid recipient address");
  }
  return bech32Encode(prefix, Buffer.from(normalized.slice(2), "hex"));
}
