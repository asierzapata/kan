import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { addMermaidDiagramInput } from "../../desktop/src/nodes/schema";
import { stripMermaidFence } from "../../desktop/src/lib/mermaid";
export type DiagramBlueprint = {
  nodes: {
    key: string;
    label: string;
    geo: "rectangle" | "ellipse" | "diamond";
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
  edges: {
    from: string;
    to: string;
    label: string;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    bind?: boolean;
  }[];
};
let tail = Promise.resolve();
// Mermaid has mutable parser databases. Serialize parsing, and provide its real
// DOMPurify sanitizer with a non-executing, non-networked DOM. No SVG is rendered.
export function parseDiagram(input: unknown): Promise<DiagramBlueprint> {
  const job = tail.then(async () => {
    const parsed = addMermaidDiagramInput.parse(input),
      source = stripMermaidFence(parsed.source);
    if (source.length > 30000) throw Error("Diagram source limit exceeded");
    const window = new JSDOM("").window;
    Object.assign(createDOMPurify, createDOMPurify(window as any));
    try {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        maxTextSize: 30000,
        flowchart: { htmlLabels: false },
      });
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(
        source.replace(/%%\{[\s\S]*?\}%%/g, ""),
      );
      const db: any = diagram.db;
      const label = (value: any) =>
        String(
          typeof value === "string"
            ? value
            : (value?.text ?? value?.description ?? ""),
        )
          .replace(/<br\s*\/?\s*>/gi, "\n")
          .replace(/<[^>]*>/g, "")
          .slice(0, 500);
      const nodes: DiagramBlueprint["nodes"] = [],
        edges: DiagramBlueprint["edges"] = [];
      if (diagram.type === "sequence") {
        const actors = [...db.getActors().entries()] as [string, any][];
        const messages = db
          .getMessages()
          .filter(
            (m: any) =>
              m.from &&
              m.to &&
              actors.some(([id]) => id === m.from) &&
              actors.some(([id]) => id === m.to),
          );
        actors.forEach(([key, actor], i) => {
          nodes.push({
            key,
            label: label(actor.description || actor.name),
            geo: "rectangle",
            x: i * 300,
            y: 0,
            w: 200,
            h: 80,
          });
          nodes.push({
            key: `lifeline:${key}`,
            label: "",
            geo: "rectangle",
            x: i * 300 + 99,
            y: 80,
            w: 2,
            h: Math.max(180, messages.length * 90 + 80),
          });
        });
        messages.forEach((message: any, i: number) => {
          const a = actors.findIndex(([id]) => id === message.from),
            b = actors.findIndex(([id]) => id === message.to);
          edges.push({
            from: message.from,
            to: message.to,
            label: label(message.message),
            bind: false,
            start: { x: a * 300 + 100, y: 150 + i * 90 },
            end: { x: b * 300 + 100, y: 150 + i * 90 + (a === b ? 40 : 0) },
          });
        });
      } else if (
        [
          "flowchart",
          "flowchart-v2",
          "stateDiagram",
          "stateDiagram-v2",
          "mindmap",
        ].includes(diagram.type)
      ) {
        const data = db.getData();
        const rawNodes = data.nodes,
          rawEdges = data.edges;
        if (rawNodes.length > 50 || rawEdges.length > 60)
          throw Error("Diagram graph limit exceeded");
        const indegree = new Map<string, number>(
            rawNodes.map((node: any) => [String(node.id), 0]),
          ),
          rank = new Map<string, number>();
        for (const edge of rawEdges)
          indegree.set(
            String(edge.end),
            (indegree.get(String(edge.end)) || 0) + 1,
          );
        const queue = rawNodes
          .filter((node: any) => indegree.get(String(node.id)) === 0)
          .map((node: any) => String(node.id));
        for (let i = 0; i < queue.length; i++) {
          const id = queue[i];
          for (const edge of rawEdges.filter(
            (edge: any) => String(edge.start) === id,
          )) {
            const end = String(edge.end);
            rank.set(
              end,
              Math.max(rank.get(end) || 0, (rank.get(id) || 0) + 1),
            );
            indegree.set(end, indegree.get(end)! - 1);
            if (indegree.get(end) === 0) queue.push(end);
          }
        }
        const rows = new Map<number, number>(),
          direction =
            typeof db.getDirection === "function" ? db.getDirection() : "LR",
          vertical = ["TB", "TD", "BT"].includes(direction);
        rawNodes.forEach((node: any) => {
          const key = String(node.id),
            level = rank.get(key) || 0,
            row = rows.get(level) || 0;
          rows.set(level, row + 1);
          const kind = String(node.shape || "").toLowerCase(),
            endpoint = kind === "statestart" || kind === "stateend";
          nodes.push({
            key,
            label: endpoint ? "" : label(node.label),
            geo: /diamond|decision/.test(kind)
              ? "diamond"
              : /circle|ellipse|stadium|state(start|end)/.test(kind)
                ? "ellipse"
                : "rectangle",
            x: vertical ? row * 300 : level * 320,
            y: vertical ? level * 200 : row * 160,
            w: endpoint ? 32 : 240,
            h: endpoint ? 32 : 110,
          });
        });
        rawEdges.forEach((edge: any) =>
          edges.push({
            from: String(edge.start),
            to: String(edge.end),
            label: label(edge.label),
          }),
        );
      } else throw Error("Use flowchart, state, sequence or mindmap diagrams");
      if (nodes.length + edges.length * 3 > 200 || !nodes.length)
        throw Error("Diagram record limit exceeded");
      return { nodes, edges };
    } finally {
      window.close();
    }
  });
  tail = job.then(
    () => {},
    () => {},
  );
  return job;
}
