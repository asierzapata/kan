import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";
import { sleep } from "workflow";
import { toolSchemas } from "../../../desktop/src/nodes/schema";
export default defineWorkflowTool({
  description:
    "removeNodes on the authorized canvas. Mutations require the revision returned by getCanvas. Scope is assigned by the server.",
  inputSchema: z.object({
    input: toolSchemas.removeNodes,
    expectedRevision: z.number().int().nonnegative().optional(),
    delaySeconds: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(0)
      .describe("Optional bounded delay when explicitly requested"),
  }),
  async execute(input, ctx) {
    "use workflow";
    if (input.delaySeconds) await sleep(`${input.delaySeconds}s`);
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
      name: "removeNodes",
      input: input.input,
      expectedRevision: input.expectedRevision,
      session: ctx.session.id,
      callId: ctx.callId,
    }),
    signal: ctx.abortSignal,
  });
  if (!response.ok)
    throw Error("Authorized tool failed; read canvas again before retrying.");
  const result = await response.json();
  if (result.crashForQa) process.exit(86);
  return result;
}
