import { toolSchemas } from "../../../apps/desktop/src/nodes/schema";
import {
  draftToShapePartial,
  shapeToSummary,
} from "../../../apps/desktop/src/nodes/draft";
import { getIndexAbove } from "@tldraw/utils";
import { toRichText } from "@tldraw/tlschema";

// Read the validated JSON rich-text tree without loading browser editor code.
function toPlainText(node: any): string {
  if (typeof node?.text === "string") return node.text;
  if (!Array.isArray(node?.content)) return "";
  return node.content.map(toPlainText).join(node.type === "doc" ? "\n" : "");
}

const geoDefaults = {
  w: 200,
  h: 200,
  geo: "rectangle",
  dash: "draw",
  growY: 0,
  url: "",
  scale: 1,
  flipX: false,
  flipY: false,
  color: "blue",
  labelColor: "black",
  fill: "none",
  size: "m",
  font: "draw",
  align: "middle",
  verticalAlign: "middle",
  richText: toRichText(""),
};
export function planTool(room: any, schema: any, command: any) {
  const { name, input, operation, run, user } = command;
  if (!(name in toolSchemas)) throw Error("Unknown tool");
  const parsed: any =
    toolSchemas[name as keyof typeof toolSchemas].parse(input);
  const records = room
    .getCurrentSnapshot()
    .documents.map((doc: any) => doc.state);
  const shapes = records.filter((record: any) => record.typeName === "shape");
  const byId = new Map<string, any>(shapes.map((s: any) => [s.id, s]));
  const requireShape = (id: string) => {
    const shape = byId.get(id);
    if (!shape) throw Error("Shape unavailable");
    return shape;
  };
  const puts: any[] = [],
    removes: string[] = [];
  const id = `shape:${operation}`;
  const stamp = { entryId: run, runId: run, byUserId: user };
  const build = (partial: any) =>
    schema.types.shape.create({
      rotation: 0,
      isLocked: false,
      opacity: 1,
      parentId: "page:page",
      index: getIndexAbove(
        shapes
          .map((shape: any) => shape.index)
          .sort()
          .at(-1) ?? null,
      ),
      meta: { provenance: stamp },
      ...partial,
      props:
        partial.type === "geo"
          ? { ...geoDefaults, ...partial.props }
          : partial.props,
    });
  if (name === "getCanvas") {
    let selected = shapes.filter(
      (shape: any) => !parsed.shapeIds || parsed.shapeIds.includes(shape.id),
    );
    const selectedCount = selected.length;
    selected = selected.slice(0, 200);
    const summary = selected.map((shape: any) =>
      shape.type.startsWith("kan-")
        ? shapeToSummary(shape)
        : {
            id: shape.id,
            type: shape.type,
            x: shape.x,
            y: shape.y,
            w: shape.props.w,
            h: shape.props.h,
            text: shape.props.richText
              ? toPlainText(shape.props.richText).slice(0, 200)
              : undefined,
          },
    );
    const result = {
      shapes: parsed.scope === "full" ? selected : summary,
      omittedCount: Math.max(0, selectedCount - selected.length),
    };
    if (JSON.stringify(result).length > 128 * 1024)
      throw Error("Canvas context too large; request specific shape IDs");
    return { result, puts, removes };
  }
  if (name === "addMermaidDiagram") {
    const blueprint = command.diagram;
    if (
      !blueprint ||
      !Array.isArray(blueprint.nodes) ||
      !Array.isArray(blueprint.edges) ||
      blueprint.nodes.length + 3 * blueprint.edges.length > 200
    )
      throw Error("Invalid diagram plan");
    const nodeIds = new Map<string, string>();
    for (const [i, node] of blueprint.nodes.entries()) {
      if (
        typeof node.key !== "string" ||
        typeof node.label !== "string" ||
        !["rectangle", "ellipse", "diamond"].includes(node.geo) ||
        ![node.x, node.y, node.w, node.h].every(Number.isFinite) ||
        node.w <= 0 ||
        node.h <= 0 ||
        Math.max(Math.abs(node.x), Math.abs(node.y), node.w, node.h) > 100000
      )
        throw Error("Invalid diagram geometry");
      const shapeId = `shape:${operation}:node:${i}`;
      nodeIds.set(node.key, shapeId);
      const record = build(
        draftToShapePartial(
          {
            type: "geo",
            geo: node.geo,
            text: node.label,
            w: node.w,
            h: node.h,
          },
          shapeId as any,
          { x: (parsed.at?.x || 0) + node.x, y: (parsed.at?.y || 0) + node.y },
          stamp,
        ),
      );
      record.index = getIndexAbove(
        [...shapes, ...puts]
          .map((shape: any) => shape.index)
          .sort()
          .at(-1) ?? null,
      );
      puts.push(record);
    }
    for (const [i, edge] of blueprint.edges.entries()) {
      const from = nodeIds.get(edge.from),
        to = nodeIds.get(edge.to);
      if (!from || !to || typeof edge.label !== "string")
        throw Error("Invalid diagram connection");
      const snapshot = room.getCurrentSnapshot();
      const diagramRoom = {
        getCurrentSnapshot: () => ({
          ...snapshot,
          documents: [
            ...snapshot.documents,
            ...puts.map((state) => ({ state })),
          ],
        }),
      };
      const planned = planTool(diagramRoom, schema, {
        name: "connectNodes",
        input: { from, to, label: edge.label },
        operation: `${operation}:edge:${i}`,
        run,
        user,
      });
      if (edge.bind === false) {
        const arrow = planned.puts.find(
          (record: any) => record.typeName === "shape",
        );
        if (
          !edge.start ||
          !edge.end ||
          ![edge.start.x, edge.start.y, edge.end.x, edge.end.y].every(
            Number.isFinite,
          )
        )
          throw Error("Invalid diagram arrow");
        arrow.props.start = {
          x: (parsed.at?.x || 0) + edge.start.x,
          y: (parsed.at?.y || 0) + edge.start.y,
        };
        arrow.props.end = {
          x: (parsed.at?.x || 0) + edge.end.x,
          y: (parsed.at?.y || 0) + edge.end.y,
        };
        puts.push(arrow);
      } else puts.push(...planned.puts);
    }
  } else if (name === "addNode") {
    let at = parsed.at || { x: 0, y: 0 };
    if (!parsed.at && parsed.near) {
      const near = requireShape(parsed.near.shapeId);
      at =
        parsed.draft.type === "logo"
          ? { x: near.x + (near.props.w || 200) - 80, y: near.y - 40 }
          : { x: near.x + (near.props.w || 200) + 40, y: near.y };
    }
    puts.push(build(draftToShapePartial(parsed.draft, id as any, at, stamp)));
  } else if (name === "updateNode") {
    const shape = requireShape(parsed.shapeId);
    if (
      shape.type !==
      (parsed.patch.type === "geo" ? "geo" : `kan-${parsed.patch.type}`)
    )
      throw Error("Shape type mismatch");
    const { type, x, y, text, ...props } = parsed.patch;
    const nextProps = { ...shape.props, ...props };
    if (text !== undefined) nextProps.richText = toRichText(text);
    if (type === "calendar") {
      if (props.selectedDate) nextProps.month = props.selectedDate.slice(0, 7);
      else if (
        props.month &&
        nextProps.selectedDate?.slice(0, 7) !== props.month
      )
        nextProps.selectedDate = null;
    }
    if (type === "chart") {
      const keys = new Set(nextProps.spec.series.map((s: any) => s.key));
      nextProps.hiddenSeries = nextProps.hiddenSeries.filter((key: string) =>
        keys.has(key),
      );
      if (
        nextProps.focusX !== null &&
        !nextProps.data.some(
          (row: any) =>
            String(row[nextProps.spec.x] ?? "") === nextProps.focusX,
        )
      )
        nextProps.focusX = null;
    }
    if (type === "table") {
      nextProps.selectedRows = [
        ...new Set(
          nextProps.selectedRows.filter(
            (i: number) => i < nextProps.rows.length,
          ),
        ),
      ];
      if (nextProps.highlightRow >= nextProps.rows.length)
        nextProps.highlightRow = -1;
      if (nextProps.sortBy?.column >= nextProps.columns.length)
        nextProps.sortBy = null;
    }
    if (type === "map" && nextProps.selectedMarker >= nextProps.markers.length)
      nextProps.selectedMarker = -1;
    if (
      type === "timeline" &&
      !nextProps.events.some(
        (event: any) => event.id === nextProps.selectedEventId,
      )
    )
      nextProps.selectedEventId = null;
    puts.push({
      ...shape,
      x: x ?? shape.x,
      y: y ?? shape.y,
      props: nextProps,
      meta: { ...shape.meta, provenance: stamp },
    });
  } else if (name === "removeNodes") {
    for (const target of parsed.shapeIds) {
      requireShape(target);
      removes.push(target);
    }
    // Include descendants and bindings to removed records to preserve graph integrity.
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records)
        if (
          !removes.includes(record.id) &&
          (removes.includes(record.parentId) ||
            removes.includes(record.fromId) ||
            removes.includes(record.toId))
        ) {
          removes.push(record.id);
          changed = true;
        }
    }
  } else if (name === "arrange") {
    const selected = parsed.shapeIds.map(requireShape),
      columns =
        parsed.layout === "row"
          ? selected.length
          : parsed.layout === "column"
            ? 1
            : Math.ceil(Math.sqrt(selected.length)),
      gap = parsed.gap ?? 40;
    const cellW = Math.max(...selected.map((s: any) => s.props.w || 200)) + gap,
      cellH = Math.max(...selected.map((s: any) => s.props.h || 200)) + gap;
    selected.forEach((shape: any, i: number) =>
      puts.push({
        ...shape,
        x: selected[0].x + (i % columns) * cellW,
        y: selected[0].y + Math.floor(i / columns) * cellH,
      }),
    );
  } else if (name === "groupNodes") {
    const selected = parsed.shapeIds.map(requireShape);
    const x = Math.min(...selected.map((s: any) => s.x)),
      y = Math.min(...selected.map((s: any) => s.y));
    puts.push(
      schema.types.shape.create({
        id,
        type: "group",
        x,
        y,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        parentId: "page:page",
        index: selected[0].index,
        props: {},
        meta: { provenance: stamp },
      }),
    );
    selected.forEach((shape: any) =>
      puts.push({ ...shape, parentId: id, x: shape.x - x, y: shape.y - y }),
    );
  } else if (name === "focusNodes") {
    parsed.shapeIds.forEach(requireShape);
    return { result: { focusShapeIds: parsed.shapeIds }, puts, removes };
  } else if (name === "connectNodes") {
    const from = requireShape(parsed.from),
      to = requireShape(parsed.to);
    puts.push(
      schema.types.shape.create({
        id,
        type: "arrow",
        x: 0,
        y: 0,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        parentId: "page:page",
        index: getIndexAbove(
          shapes
            .map((shape: any) => shape.index)
            .sort()
            .at(-1) ?? null,
        ),
        meta: { provenance: stamp },
        props: {
          kind: "arc",
          elbowMidPoint: 0.5,
          dash: "draw",
          size: "m",
          fill: "none",
          color: "black",
          labelColor: "black",
          bend: 0,
          start: { x: from.x + from.props.w / 2, y: from.y + from.props.h / 2 },
          end: { x: to.x + to.props.w / 2, y: to.y + to.props.h / 2 },
          arrowheadStart: "none",
          arrowheadEnd: "arrow",
          richText: toRichText(parsed.label || ""),
          font: "draw",
          labelPosition: 0.5,
          scale: 1,
        },
      }),
    );
    for (const [terminal, target] of [
      ["start", from],
      ["end", to],
    ])
      puts.push(
        schema.types.binding.create({
          id: `binding:${operation}:${terminal}`,
          type: "arrow",
          fromId: id,
          toId: target.id,
          props: {
            terminal,
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: true,
            snap: "none",
          },
          meta: {},
        }),
      );
  } else throw Error("This server tool is not implemented");
  if (
    puts.length + removes.length > 200 ||
    JSON.stringify(puts).length > 1024 * 1024
  )
    throw Error("Tool change too large");
  puts.forEach((record) =>
    schema.types[record.typeName as "shape"].validate(record),
  );
  return {
    puts,
    removes,
    result: {
      shapeIds: puts.filter((r) => r.typeName === "shape").map((r) => r.id),
      removed: removes,
    },
  };
}
