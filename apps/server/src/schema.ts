import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import {
  markdownShapeProps,
  chartShapeProps,
  tableShapeProps,
  imageShapeProps,
  mapShapeProps,
  logoShapeProps,
  timelineShapeProps,
  calendarShapeProps,
} from "../../desktop/src/nodes/shapes/types.ts";

export const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "kan-markdown": { props: markdownShapeProps },
    "kan-chart": { props: chartShapeProps },
    "kan-table": { props: tableShapeProps },
    "kan-image": { props: imageShapeProps },
    "kan-map": { props: mapShapeProps },
    "kan-logo": { props: logoShapeProps },
    "kan-timeline": { props: timelineShapeProps },
    "kan-calendar": { props: calendarShapeProps },
  },
});
