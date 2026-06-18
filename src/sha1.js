// Pure-JS SHA-1. Zero dependencies, synchronous, identical in Node and browsers.
//
// Anki computes a note's `csum` as the first 4 bytes of the SHA-1 of the first
// field's (HTML-stripped) text. WebCrypto's digest is async, which would force
// note normalization to be async too; a small synchronous SHA-1 keeps the data
// model clean and dependency-free. Validated against the standard "test" vector.

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

/**
 * SHA-1 digest of a string (UTF-8) or byte array.
 * @param {string | Uint8Array} input
 * @returns {Uint8Array} 20-byte digest
 */
export function sha1Bytes(input) {
  const msg = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const bitLen = msg.length * 8;

  // Pad: 0x80, then zeros to 56 mod 64, then 64-bit big-endian bit length.
  const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0 >>> 0, false);
  ov.setUint32(4, h1 >>> 0, false);
  ov.setUint32(8, h2 >>> 0, false);
  ov.setUint32(12, h3 >>> 0, false);
  ov.setUint32(16, h4 >>> 0, false);
  return out;
}

/** Hex string of the SHA-1 digest. @param {string|Uint8Array} input */
export function sha1Hex(input) {
  return Array.from(sha1Bytes(input), (b) => b.toString(16).padStart(2, "0")).join("");
}
