import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";
import { toolSchemas } from "../../../desktop/src/nodes/schema";
export default defineWorkflowTool({
  description:
    "getCanvas on the authorized canvas. Mutations require the revision returned by getCanvas. Scope is assigned by the server.",
  inputSchema: z.object({
    input: toolSchemas.getCanvas,
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  async execute(input, ctx) {
    "use workflow";
    return callCanvas(input, ctx);
  },
});
async function callCanvas(input: any, ctx: WorkflowStepToolContext) {
  "use step";
  ctx.abortSignal.throwIfAborted();
  const response = await fetch(`${process.env.WEB_API_URL}/internal`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.STAGING_SECRET}`,
    },
    body: JSON.stringify({
      action: "tool",
      name: "getCanvas",
      input: input.input,
      expectedRevision: input.expectedRevision,
      session: ctx.session.id,
      callId: ctx.callId,
    }),
    signal: ctx.abortSignal,
  });
  if (!response.ok)
    throw Error("Authorized tool failed; read canvas again before retrying.");
  return response.json();
}
