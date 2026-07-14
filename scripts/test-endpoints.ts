/**
 * Quick endpoint test for bee LM + embedding endpoints.
 * Run: bun run scripts/test-endpoints.ts
 */

const lmFile = await Bun.file("bee.lm.json").json().catch(() => ({})) as Record<string, string>;

const BASE    = lmFile.url ?? lmFile.CB_LM_URL ?? process.env.CB_LM_URL ?? "";
const API_KEY = lmFile.apiKey ?? lmFile.CB_API_KEY ?? process.env.CB_API_KEY ?? "";
const PATH_PREF = "/v1/chat/completions";
const LM_MODEL = lmFile.model ?? lmFile.CB_LM_MODEL ?? process.env.CB_LM_MODEL ?? "default";
const EMB_MODEL = lmFile.embeddingModel ?? lmFile.CB_EMBEDDING_MODEL ?? process.env.CB_EMBEDDING_MODEL ?? "";
const EMB_URL  = lmFile.embeddingUrl ?? lmFile.CB_EMBEDDING_URL ?? process.env.CB_EMBEDDING_URL ?? `${BASE}/v1/embeddings`;

const headers = {
  "content-type": "application/json",
  ...(API_KEY ? { authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY } : {}),
};

async function test(label: string, url: string, body: object): Promise<void> {
  process.stdout.write(`  ${label} ... `);
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      process.stdout.write(`✓ ${r.status}\n`);
    } else {
      const text = (await r.text()).slice(0, 200);
      process.stdout.write(`✗ ${r.status} — ${text}\n`);
    }
  } catch (e) {
    process.stdout.write(`✗ ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}\n`);
  }
}

console.log(`Base: ${BASE}`);
console.log(`LM model: ${LM_MODEL}`);
console.log(`EMB model: ${EMB_MODEL}`);
console.log(`EMB URL: ${EMB_URL}`);
console.log(`Chat path: ${PATH_PREF}\n`);

const chatUrl = `${BASE.replace(/\/+$/, "")}${PATH_PREF}`;
await test("Chat (v1/chat/completions)", chatUrl, {
  model: LM_MODEL, messages: [{ role: "user", content: "say hi" }], max_tokens: 10, temperature: 0,
});

await test("Embedding (configured URL)", EMB_URL, {
  input: "hello world", model: EMB_MODEL,
});
