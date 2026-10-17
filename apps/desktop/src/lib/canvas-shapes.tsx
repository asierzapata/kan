/**
 * Client-side rendering for the custom canvas node.
 *
 * The *schema* lives in `packages/nodes` because the shared tool layer validates
 * records against it too, and a disagreement between the two sides makes the
 * sync layer reject the record with `INVALID_RECORD`. This file only adds the
 * React half: it imports `kanShapeProps` rather than restating it, so there is
 * still exactly one definition of what a node holds.
 */
import { BaseBoxShapeUtil, HTMLContainer } from "tldraw";
import {
  KAN_NODE_HEIGHT,
  KAN_NODE_TYPE,
  KAN_NODE_WIDTH,
  kanShapeProps,
  type KanNodeShape,
} from "@kan/nodes";
import type { NodeDraft } from "@kan/protocol";
import { CalendarView } from "@/nodes/shapes/CalendarShapeUtil";
import { initialMonth } from "@/nodes/dates";

/**
 * tldraw 5 resolves `TLShape` through a global registry rather than a plain
 * generic, so a custom shape is invisible to the editor's types until it is
 * declared here. The props must match `kanShapeProps` in `packages/nodes`,
 * which stays the runtime source of truth for both the client and the server.
 */
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "kan-node": { w: number; h: number; draft: NodeDraft };
  }
}

/** Every draft kind carries a heading, but not under the same key. */
function draftTitle(draft: NodeDraft): string {
  if (draft.type === "concept") return draft.label;
  if (draft.type === "logo") return draft.name ?? draft.domain;
  return draft.title;
}

function DraftBody({ draft }: { draft: NodeDraft }) {
  switch (draft.type) {
    case "markdown":
      return <p className="whitespace-pre-wrap">{draft.body}</p>;

    case "decision":
      return (
        <ul className="flex list-disc flex-col gap-1 ps-4">
          {draft.bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      );

    case "concept":
      return draft.glyph ? <span className="text-2xl">{draft.glyph}</span> : null;

    case "table":
      return (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {draft.columns.map((column) => (
                <th key={column} className="border border-border px-1 text-start">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draft.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="border border-border px-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );

    case "chart":
      // Deliberately not a real chart yet. The agent can already produce the
      // spec and the data; picking a chart library is its own decision and
      // rendering one badly is worse than showing the shape of the answer.
      return (
        <div className="flex flex-col gap-1 text-muted-foreground">
          <span>{draft.data.length} rows</span>
          {draft.sourceNote ? <span>{draft.sourceNote}</span> : null}
        </div>
      );

    case "logo":
      return <span className="text-muted-foreground">{draft.domain}</span>;
  }
}

export class KanNodeUtil extends BaseBoxShapeUtil<KanNodeShape> {
  static override type = KAN_NODE_TYPE;
  static override props = kanShapeProps;

  override getDefaultProps(): KanNodeShape["props"] {
    return {
      w: KAN_NODE_WIDTH,
      h: KAN_NODE_HEIGHT,
      draft: { type: "concept", label: "Untitled" },
    };
  }

  override canResize() {
    return true;
  }

  override canScroll(shape: KanNodeShape) {
    return shape.props.draft.type === "calendar";
  }

  override component(shape: KanNodeShape) {
    const { draft } = shape.props;
    if (draft.type === "calendar") {
      return <CalendarView
        props={{ w: shape.props.w, h: shape.props.h, title: draft.title, events: draft.events, sourceNote: draft.sourceNote ?? "", month: draft.selectedDate?.slice(0, 7) ?? draft.month ?? initialMonth(draft.events), selectedDate: draft.selectedDate ?? null }}
        onChange={({ month, selectedDate }) => this.editor.updateShape({ id: shape.id, type: shape.type, props: { draft: { ...draft, ...(month !== undefined ? { month } : {}), ...(selectedDate !== undefined ? { selectedDate } : {}) } } })}
      />;
    }
    return (
      <HTMLContainer
        className="flex flex-col gap-2 overflow-hidden border border-border bg-background p-3 font-mono text-xs"
        style={{ width: shape.props.w, height: shape.props.h }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground">{draft.type}</span>
          <span className="min-w-0 truncate font-bold">{draftTitle(draft)}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <DraftBody draft={draft} />
        </div>
      </HTMLContainer>
    );
  }

  // SVG indicators are gone in tldraw 5; the selection outline is a Path2D now.
  override getIndicatorPath(shape: KanNodeShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

/** Passed to both `<Tldraw>` and, later, the sync client. */
export const shapeUtils = [KanNodeUtil];
