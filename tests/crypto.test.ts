/**
 * Unit tests for AES-256-GCM session crypto.
 * Each test that touches getMachineSecret / deriveKey uses a dedicated temp dir
 * so the secret file is isolated and cleaned up after each suite.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "node:crypto";
import { CBError } from "../src/core/api/errors";

// Import crypto module after env vars would be set in individual tests.
// These imports are fine here because encryptToken/decryptToken take an explicit key.
import {
  getMachineSecret,
  deriveKey,
  encryptToken,
  decryptToken,
} from "../src/core/session/crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp dir with its own DB path and return both paths. */
function makeTempDir(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "bee-crypto-"));
  const dbPath = join(dir, "test.db");
  return { dir, dbPath };
}

// ---------------------------------------------------------------------------
// encryptToken / decryptToken roundtrip
// ---------------------------------------------------------------------------

describe("encryptToken / decryptToken", () => {
  let key: Buffer;

  beforeAll(() => {
    // Use a fresh random key for the roundtrip tests — no file I/O needed.
    key = randomBytes(32);
  });

  test("encrypt then decrypt returns original plaintext", () => {
    const plaintext = "super-secret-api-token-abc123";
    const encrypted = encryptToken(plaintext, key);
    const decrypted = decryptToken(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  test("encrypt then decrypt with Unicode plaintext", () => {
    const plaintext = "tôken:with-ünïcödé-çhàrš";
    const encrypted = encryptToken(plaintext, key);
    expect(decryptToken(encrypted, key)).toBe(plaintext);
  });

  test("encrypt then decrypt with empty string", () => {
    const plaintext = "";
    const encrypted = encryptToken(plaintext, key);
    expect(decryptToken(encrypted, key)).toBe(plaintext);
  });

  test("encrypt then decrypt with long token", () => {
    const plaintext = "a".repeat(1000);
    const encrypted = encryptToken(plaintext, key);
    expect(decryptToken(encrypted, key)).toBe(plaintext);
  });

  test("two encryptions of same plaintext produce different ciphertexts (random IV)", () => {
    const plaintext = "same-plaintext";
    const enc1 = encryptToken(plaintext, key);
    const enc2 = encryptToken(plaintext, key);
    // Ciphertexts should differ because IVs are random
    expect(enc1).not.toBe(enc2);
    // But both must decrypt to the same original
    expect(decryptToken(enc1, key)).toBe(plaintext);
    expect(decryptToken(enc2, key)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// decryptToken failure cases
// ---------------------------------------------------------------------------

describe("decryptToken — tamper detection", () => {
  let key: Buffer;

  beforeAll(() => {
    key = randomBytes(32);
  });

  test("decryptToken throws on tampered ciphertext (GCM auth tag fail)", () => {
    const plaintext = "my-api-token";
    const encrypted = encryptToken(plaintext, key);
    const buf = Buffer.from(encrypted, "base64");

    // Flip a byte in the ciphertext portion (after iv(12) + tag(16) = 28 bytes)
    // If plaintext is non-empty there will be ciphertext bytes to tamper with.
    const tampered = Buffer.from(buf);
    const ciphertextOffset = 12 + 16; // IV_LEN + TAG_LEN
    if (tampered.length > ciphertextOffset) {
      tampered[ciphertextOffset] ^= 0xff;
    } else {
      // Tamper the auth tag itself
      tampered[12] ^= 0xff;
    }
    const tamperedEncoded = tampered.toString("base64");
    expect(() => decryptToken(tamperedEncoded, key)).toThrow(Error);
  });

  test("decryptToken throws when auth tag is modified", () => {
    const plaintext = "token-for-tag-test";
    const encrypted = encryptToken(plaintext, key);
    const buf = Buffer.from(encrypted, "base64");

    // Flip a byte inside the auth tag (bytes 12..27)
    const tampered = Buffer.from(buf);
    tampered[12] ^= 0x01;
    expect(() => decryptToken(tampered.toString("base64"), key)).toThrow(Error);
  });

  test("decryptToken throws with a wrong key", () => {
    const plaintext = "real-token";
    const encrypted = encryptToken(plaintext, key);
    const wrongKey = randomBytes(32);
    expect(() => decryptToken(encrypted, wrongKey)).toThrow(Error);
  });

  test("decryptToken throws with a key derived from a different secret", () => {
    const { dir: dir1, dbPath: db1 } = makeTempDir();
    const { dir: dir2, dbPath: db2 } = makeTempDir();
    try {
      // Initialise two separate machine secrets
      getMachineSecret(db1);
      getMachineSecret(db2);
      const key1 = deriveKey(db1);
      const key2 = deriveKey(db2);

      const plaintext = "cross-key-test";
      const encrypted = encryptToken(plaintext, key1);
      // Decrypting with a key derived from a different secret should fail
      // (with overwhelming probability — the two secrets are independently random)
      try {
        const result = decryptToken(encrypted, key2);
        // If it somehow doesn't throw (astronomically unlikely), at least the result differs
        expect(result).not.toBe(plaintext);
      } catch {
        // Expected path: GCM auth tag mismatch
      }
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("decryptToken throws for ciphertext that is too short", () => {
    const shortBuf = randomBytes(10); // less than IV_LEN + TAG_LEN = 28
    expect(() => decryptToken(shortBuf.toString("base64"), key)).toThrow(CBError);
  });
});

// ---------------------------------------------------------------------------
// getMachineSecret
// ---------------------------------------------------------------------------

describe("getMachineSecret", () => {
  test("creates a 32-byte secret file on first call", () => {
    const { dir, dbPath } = makeTempDir();
    try {
      const secret = getMachineSecret(dbPath);
      expect(secret.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("secret file has mode 0600", () => {
    const { dir, dbPath } = makeTempDir();
    try {
      getMachineSecret(dbPath);
      const secretPath = join(dir, ".bee_secret");
      expect(existsSync(secretPath)).toBe(true);
      const mode = statSync(secretPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("second call returns the same secret (file is not regenerated)", () => {
    const { dir, dbPath } = makeTempDir();
    try {
      const first = getMachineSecret(dbPath);
      const second = getMachineSecret(dbPath);
      expect(first.equals(second)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("different temp dirs produce different secrets", () => {
    const t1 = makeTempDir();
    const t2 = makeTempDir();
    try {
      const s1 = getMachineSecret(t1.dbPath);
      const s2 = getMachineSecret(t2.dbPath);
      // Two independently generated random secrets should differ
      expect(s1.equals(s2)).toBe(false);
    } finally {
      rmSync(t1.dir, { recursive: true, force: true });
      rmSync(t2.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// deriveKey
// ---------------------------------------------------------------------------

describe("deriveKey", () => {
  test("returns a 32-byte Buffer", () => {
    const { dir, dbPath } = makeTempDir();
    try {
      const key = deriveKey(dbPath);
      expect(key.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same dbPath produces the same derived key", () => {
    const { dir, dbPath } = makeTempDir();
    try {
      const k1 = deriveKey(dbPath);
      const k2 = deriveKey(dbPath);
      expect(k1.equals(k2)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("different secrets produce different derived keys", () => {
    const t1 = makeTempDir();
    const t2 = makeTempDir();
    try {
      const k1 = deriveKey(t1.dbPath);
      const k2 = deriveKey(t2.dbPath);
      expect(k1.equals(k2)).toBe(false);
    } finally {
      rmSync(t1.dir, { recursive: true, force: true });
      rmSync(t2.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end: deriveKey → encrypt → decrypt
// ---------------------------------------------------------------------------

describe("end-to-end encrypt/decrypt with deriveKey", () => {
  test("encrypt with derived key, decrypt with same derived key succeeds", () => {
    const { dir, dbPath } = makeTempDir();
    try {
      const key = deriveKey(dbPath);
      const plaintext = "end-to-end-test-token";
      const encrypted = encryptToken(plaintext, key);
      expect(decryptToken(encrypted, key)).toBe(plaintext);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
