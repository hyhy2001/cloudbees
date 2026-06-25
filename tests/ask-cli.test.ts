import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

// ── Mock LM server: responds instantly with a canned answer ─────────────────
let mockUrl = "";
let mockServer: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") return new Response(JSON.stringify({ data: [{ id: "mock" }] }));
      if (url.pathname === "/v1/chat/completions") {
        const body = await req.json() as { messages: Array<{ role?: string; content?: string }>; stream?: boolean };
        const queryMsg = body.messages?.find((m) => m.role === "user")?.content ?? "";
        const text = queryMsg.includes("what is a profile")
          ? "A profile is a saved login target for one CloudBees server."
          : "Use `bee job stop <name>` to cancel a running build.";

        if (body.stream) {
          // SSE streaming response
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
              controller.enqueue(encoder.encode(payload));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }

        // Non-streaming response
        return new Response(JSON.stringify({
          choices: [{ message: { content: text, role: "assistant" } }],
        }));
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(() => { mockServer?.stop(); });

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const lmUrl = extraEnv.CB_DATABRICK_URL ?? mockUrl;
  // Ensure no OAuth credentials leak from parent env into subprocess.
  const env = {
    ...process.env,
    ...extraEnv,
    CB_DB_PATH: "/tmp/bee-ask-cli-test.db",
    CB_DATABRICK_URL: lmUrl,
    CB_LM_URL: "",
    CB_CLIENT_ID: "",
    CB_CLIENT_SECRET: "",
  };
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], { stdout: "pipe", stderr: "pipe", env });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out, err };
}

describe("bee ask CLI", () => {
  test("returns command answer with usage", async () => {
    const { code, out } = await runCli(["ask", "stop", "build"]);
    expect(code).toBe(0);
    expect(out).toContain("bee job stop <name>");
    expect(out).not.toContain("concepts.md");
  });

  test("returns concept answer with explanation text", async () => {
    const { code, out } = await runCli(["ask", "what", "is", "a", "profile"]);
    expect(code).toBe(0);
    expect(out).toContain("A profile is a saved login target");
    expect(out).not.toContain("concepts.md");
  });

  test("supports --json output", async () => {
    const { code, out } = await runCli(["ask", "switch", "profile", "--json"]);
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.query).toBe("switch profile");
    expect(typeof data.answer).toBe("string");
    expect(Array.isArray(data.hits)).toBe(true);
    expect(data.hits.length).toBeGreaterThan(0);
  });

  test("can include raw doc chunks only when explicitly enabled", async () => {
    const { code, out } = await runCli(["ask", "global", "keys", "tab"], { BEE_ASK_INCLUDE_DOC_CHUNKS: "1" });
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });

  test("errors when no LM provider is configured", async () => {
    const { code, err } = await runCli(["ask", "list", "jobs"], { CB_DATABRICK_URL: "" });
    expect(code).toBe(1);
    expect(err.toLowerCase()).toContain("lm provider");
  });

  test("shows helpful message with no LM and -h/--help", async () => {
    const { code, out } = await runCli(["ask", "-h"]);
    expect(code).toBe(0);
    expect(out).toContain("Ask how to use bee");
  });
});
