import type { Command } from "commander";
import type { DocItem } from "./corpus";

/**
 * Lightweight command graph built from the commander tree.
 *
 * Nodes = command ids (`job.create.freestyle`, `node.delete`, …).
 * Edges = same group (all `job.*` commands) + CRUD resource affinity
 * (create/update/delete on the same resource, e.g.
 * `job.create.freestyle` ↔ `job.update.freestyle` ↔ `job.delete`).
 *
 * On query, graph expansion pulls in related commands that BM25 may have
 * ranked lower, so the prompt context includes the full CRUD family for
 * the resource the user is asking about.
 */

export interface CommandGraph {
  /** All command ids in the graph. */
  nodes: Set<string>;
  /** Map: command id → set of neighbor ids. */
  edges: Map<string, Set<string>>;
  /** Map: resource key (e.g. "job.freestyle") → set of command ids. */
  resourceMap: Map<string, Set<string>>;
  /** Map: group name (e.g. "job") → set of command ids. */
  groupMap: Map<string, Set<string>>;
}

const CRUD_RESOURCE = /^([a-z]+)\.(create|update|delete|get|list|run|stop|log)\.?([a-z]*)$/;

/**
 * Build a graph from a DocItem array (commands only).
 * Each command id encodes group → resource → action.
 */
export function buildGraphFromCorpus(corpus: DocItem[]): CommandGraph {
  const graph: CommandGraph = {
    nodes: new Set(),
    edges: new Map(),
    resourceMap: new Map(),
    groupMap: new Map(),
  };

  for (const item of corpus) {
    if (item.type !== "command") continue;
    const id = item.id;
    graph.nodes.add(id);

    const group = id.split(".")[0];
    if (group) {
      if (!graph.groupMap.has(group)) graph.groupMap.set(group, new Set());
      graph.groupMap.get(group)!.add(id);
    }

    const m = CRUD_RESOURCE.exec(id);
    if (m) {
      const resource = m[3] ? `${m[1]}.${m[3]}` : m[1];
      if (!graph.resourceMap.has(resource)) graph.resourceMap.set(resource, new Set());
      graph.resourceMap.get(resource)!.add(id);
    }
  }

  // Build edges: same-group + same-resource
  for (const [, members] of graph.groupMap) {
    for (const a of members) {
      for (const b of members) {
        if (a !== b) addEdge(graph, a, b);
      }
    }
  }
  for (const [, members] of graph.resourceMap) {
    for (const a of members) {
      for (const b of members) {
        if (a !== b) addEdge(graph, a, b);
      }
    }
  }

  return graph;
}

function addEdge(graph: CommandGraph, a: string, b: string): void {
  if (!graph.edges.has(a)) graph.edges.set(a, new Set());
  graph.edges.get(a)!.add(b);
}

/**
 * Given a list of BM25 hits, expand with related commands from the graph.
 * Returns additional DocItems (not already in `hits`) up to `maxExtra`.
 */
export function expandGraph(
  hits: DocItem[],
  corpus: DocItem[],
  graph: CommandGraph,
  maxExtra = 3,
): DocItem[] {
  if (graph.edges.size === 0) return [];

  const hitIds = new Set(hits.map((h) => h.id));
  const seen = new Set(hitIds);
  const extra: DocItem[] = [];

  const idMap = new Map<string, DocItem>();
  for (const item of corpus) {
    if (item.type === "command") idMap.set(item.id, item);
  }

  for (const hit of hits) {
    if (!graph.edges.has(hit.id)) continue;
    for (const neighborId of graph.edges.get(hit.id)!) {
      if (seen.has(neighborId)) continue;
      seen.add(neighborId);
      const neighbor = idMap.get(neighborId);
      if (neighbor) {
        extra.push(neighbor);
        if (extra.length >= maxExtra) return extra;
      }
    }
  }

  return extra;
}

