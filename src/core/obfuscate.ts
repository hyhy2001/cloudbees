/**
 * Simple XOR obfuscation to prevent plaintext secrets from appearing in
 * `strings ./bee` output. This is NOT cryptographic security — it only raises
 * the bar against casual inspection. Real protection comes from:
 *   - Source-only releases (users build with their own credentials)
 *   - Runtime env vars (CB_API_KEY etc.) which override baked values
 *   - .bee_secret + AES-256-GCM for stored tokens (session/crypto.ts)
 *
 * Encoding: hex(key) + ":" + hex(xor(plaintext, repeating key))
 * Both key and ciphertext are hex-encoded so they appear as opaque hex strings
 * rather than readable text in the binary.
 */

/** Encode plaintext → "hexKey:hexCiphertext" */
export function xorEncode(plaintext: string, key: Buffer): string {
  const pt = Buffer.from(plaintext, "utf8");
  const ct = Buffer.alloc(pt.length);
  for (let i = 0; i < pt.length; i++) {
    ct[i] = pt[i]! ^ key[i % key.length]!;
  }
  return `${key.toString("hex")}:${ct.toString("hex")}`;
}

/** Decode "hexKey:hexCiphertext" → plaintext */
export function xorDecode(encoded: string): string {
  const colon = encoded.indexOf(":");
  if (colon === -1) return encoded; // not encoded, return as-is
  const key = Buffer.from(encoded.slice(0, colon), "hex");
  const ct = Buffer.from(encoded.slice(colon + 1), "hex");
  if (key.length === 0) return encoded;
  const pt = Buffer.alloc(ct.length);
  for (let i = 0; i < ct.length; i++) {
    pt[i] = ct[i]! ^ key[i % key.length]!;
  }
  return pt.toString("utf8");
}
