/**
 * Quick endpoint test for bee LM + embedding endpoints.
 * Run: bun run scripts/test-endpoints.ts
 */

const lmFile = await Bun.file("bee.lm.json").json().catch(() => ({})) as Record<string, string>;

const BASE    = lmFile.url ?? lmFile.CB_LM_URL ?? process.env.CB_LM_URL ?? "";
const API_KEY = lmFile.apiKey ?? lmFile.CB_API_KEY ?? process.env.CB_API_KEY ?? "";
const CLI_ID  = lmFile.clientId ?? lmFile.CB_CLIENT_ID ?? process.env.CB_CLIENT_ID ?? "";
const CLI_SEC = lmFile.clientSecret ?? lmFile.CB_CLIENT_SECRET ?? process.env.CB_CLIENT_SECRET ?? "";
const PATH_PREF = lmFile.chatPath ?? lmFile.CB_CHAT_PATH ?? process.env.CB_CHAT_PATH ?? "/v1/chat/completions";
const LM_MODEL = lmFile.model ?? lmFile.CB_LM_MODEL ?? process.env.CB_LM_MODEL ?? "default";
const EMB_MODEL = lmFile.embeddingModel ?? lmFile.CB_EMBEDDING_MODEL ?? process.env.CB_EMBEDDING_MODEL ?? "";
const EMB_PATH = lmFile.embeddingPath ?? lmFile.CB_EMBEDDING_PATH ?? process.env.CB_EMBEDDING_PATH ?? "/v1/embeddings";
const EMB_URL  = lmFile.embeddingUrl ?? lmFile.CB_EMBEDDING_URL ?? process.env.CB_EMBEDDING_URL ?? `${BASE}${EMB_PATH}`;

let token = API_KEY;

if (CLI_ID && CLI_SEC) {
  const r = await fetch(`${BASE}/oidc/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&scope=all-apis&client_id=${CLI_ID}&client_secret=${CLI_SEC}`,
  });
  if (r.ok) token = ((await r.json()) as { access_token: string }).access_token;
}

const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };

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
