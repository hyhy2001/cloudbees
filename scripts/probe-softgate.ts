/**
 * Probe: confirm softGate recovers the on-domain queries the hard gate empties.
 *
 * Phase C of rag-eval tests the HARD gate in isolation (no softGate), so it
 * cannot show the raw `bee ask` path behaviour. This probes the exact options
 * the raw path uses: { gate: true, softGate: true }.
 */
import { Command } from "commander";
import { initPlugins } from "../src/registry/index";
import { buildCorpus, searchDocs } from "../src/plugins/docs/corpus";

const program = new Command();
await initPlugins(program);
const corpus = buildCorpus(program);

// The 4 on-domain queries the hard gate wrongly emptied in the last eval.
const RECOVERED = [
  "what does mine mean",
  "how does the cache work",
  "what is a controller",
  "first time setup",
];

function show(q: string): void {
  const ungated = searchDocs(q, corpus, 5);
  const soft = searchDocs(q, corpus, 5, { gate: true, softGate: true });
  console.log(`\n"${q}"`);
  console.log(`  ungated (today): ${ungated.map((h) => h.id).join(", ") || "(none)"}`);
  console.log(`  gate+soft (new): ${soft.map((h) => h.id).join(", ") || "(none)"}`);
}

console.log("=== Primary fix: the original noisy query ===");
show("How to create credential");

console.log("\n=== The 4 Phase-C 'lost' on-domain queries ===");
for (const q of RECOVERED) show(q);
