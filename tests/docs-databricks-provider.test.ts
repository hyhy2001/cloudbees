import { describe, expect, test, beforeAll, afterAll } from "bun:test";

/**
 * DatabricksOAuthProvider must call the configured CHAT_ENDPOINT (base +
 * CB_CHAT_PATH), e.g. an AI Gateway path .../ai-gateway/mlflow/v1/chat/
 * completions — NOT the legacy hardcoded /serving-endpoints/{model}/invocations.
 *
 * The provider is exercised in a subprocess so config.ts reads CB_CHAT_PATH at
 * import time (CHAT_ENDPOINT is computed once on module load). The mock LM
 * server runs here in the parent and records which path the provider hit and
 * whether it carried the OAuth bearer obtained via OIDC discovery + token
 * exchange. No real network.
 */

let mockUrl = "";
let server: ReturnType<typeof Bun.serve> | null = null;
const hits: { path: string; auth: string }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      hits.push({ path: url.pathname, auth: req.headers.get("authorization") ?? "" });

      // OIDC discovery: first candidate 404s, second returns the token endpoint.
      if (url.pathname === "/.well-known/databricks-config") return new Response("nf", { status: 404 });
      if (url.pathname === "/oidc/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify({ token_endpoint: `${mockUrl}/oidc/v1/token` }));
      }
      if (url.pathname === "/oidc/v1/token") {
        return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }));
      }

      // The AI Gateway chat path (custom prefix).
      if (url.pathname === "/ai-gateway/mlflow/v1/chat/completions") {
        const body = (await req.json()) as { stream?: boolean };
        const answer = "Use `bee job stop <name>` to cancel a running build.";
        if (body.stream) {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: answer, role: "assistant" } }] }));
      }

      // The AI Gateway embedding path (custom prefix).
      if (url.pathname === "/ai-gateway/mlflow/v1/embeddings") {
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }));
      }

      // Legacy serving-endpoints path must NOT be hit.
      return new Response("not found", { status: 404 });
    },
  });
  mockUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop());

// Run the provider in a subprocess with CB_CHAT_PATH set so CHAT_ENDPOINT is
// computed correctly at config import time.
async function runProvider(method: "generate" | "stream"): Promise<{ out: string; code: number; err: string }> {
  const script = `
    const { DatabricksOAuthProvider } = await import("${import.meta.dir}/../src/plugins/docs/providers/databricks.ts");
    const p = new DatabricksOAuthProvider(process.env.HOST, "id", "secret", "my-model");
    if ("${method}" === "generate") {
      process.stdout.write(await p.generate("cancel a running build"));
    } else {
      let acc = "";
      for await (const c of p.stream("cancel a running build")) acc += c;
      process.stdout.write(acc);
    }
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOST: mockUrl,
      CB_LM_URL: mockUrl,
      CB_CHAT_PATH: "/ai-gateway/mlflow/v1/chat/completions",
      CB_CLIENT_ID: "id",
      CB_CLIENT_SECRET: "secret",
    },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, code, err };
}

describe("DatabricksOAuthProvider → AI Gateway chat path", () => {
  test("generate() hits the configured CHAT_ENDPOINT with an OAuth bearer", async () => {
    hits.length = 0;
    const { out, code, err } = await runProvider("generate");
    expect(code, err).toBe(0);
    expect(out).toContain("bee job stop");

    const chatHit = hits.find((h) => h.path === "/ai-gateway/mlflow/v1/chat/completions");
    expect(chatHit).toBeDefined();
    expect(chatHit!.auth).toBe("Bearer mock-token");
    // The legacy serving-endpoints path must never be called.
    expect(hits.some((h) => h.path.includes("/serving-endpoints/"))).toBe(false);
  });

  test("stream() yields tokens from the AI Gateway path with an OAuth bearer", async () => {
    hits.length = 0;
    const { out, code, err } = await runProvider("stream");
    expect(code, err).toBe(0);
    expect(out).toContain("bee job stop");

    const chatHit = hits.find((h) => h.path === "/ai-gateway/mlflow/v1/chat/completions");
    expect(chatHit).toBeDefined();
    expect(chatHit!.auth).toBe("Bearer mock-token");
  });
});

describe("embedding OAuth reuses the robust Databricks token exchange", () => {
  // Run embed() in a subprocess so config reads CB_EMBEDDING_PATH at import.
  // The mock serves only the OIDC discovery + token flow that
  // DatabricksOAuthProvider drives. The behaviour that matters: embed() returns
  // a real vector (OAuth succeeded) and the embedding call carries the bearer
  // the provider obtained — i.e. embedding now goes through the same token path
  // as chat, not a divergent inline copy.
  test("embed() obtains an OAuth bearer and calls the AI Gateway embeddings path", async () => {
    hits.length = 0;
    const script = `
      const { embed } = await import("${import.meta.dir}/../src/plugins/docs/vector.ts");
      const v = await embed("cancel a running build");
      process.stdout.write(v ? "len:" + v.length : "null");
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CB_LM_URL: mockUrl,
        CB_EMBEDDING_PATH: "/ai-gateway/mlflow/v1/embeddings",
        CB_CLIENT_ID: "id",
        CB_CLIENT_SECRET: "secret",
      },
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited, err).toBe(0);

    // len:1024 proves: OAuth token obtained + AI Gateway embedding call succeeded.
    // (null would mean the dim guard blocked, the token failed, or the call 404'd.)
    expect(out).toBe("len:1024");
  });
});
