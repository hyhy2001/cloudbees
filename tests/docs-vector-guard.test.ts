import { describe, it, expect } from "bun:test";
import { cosineSimilarity } from "../src/plugins/docs/vector";
import { DIM, VEC_IDS, VEC_B64 } from "../src/generated/embeddings";

// The dim-integrity check: VEC_B64 must decode to exactly VEC_IDS.length ×
// DIM Int16 values. If these drift after a regenerate, vector search silently
// produces wrong cosine scores.

describe("embedding metadata integrity", () => {
  it("DIM is present and positive", () => {
    expect(DIM).toBeGreaterThan(0);
  });

  it("VEC_B64 decodes to exactly VEC_IDS.length × DIM Int16 values", () => {
    const raw = new Int16Array(Buffer.from(VEC_B64, "base64").buffer);
    expect(raw.length).toBe(VEC_IDS.length * DIM);
  });
});

describe("cosineSimilarity dim-mismatch safety", () => {
  // This documents WHY the guard exists: cosine over ragged vectors yields NaN
  // (b[i] is undefined past its length), which would silently corrupt ranking.
  // The guard returns null on a dim mismatch so this path never runs in prod.
  it("yields NaN on mismatched lengths — the failure the guard prevents", () => {
    const a = new Array(DIM).fill(0.1);
    const b = new Array(DIM - 1).fill(0.1);
    expect(Number.isNaN(cosineSimilarity(a, b))).toBe(true);
  });

  it("identical unit vectors score ~1", () => {
    const a = [0.6, 0.8];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });
});
