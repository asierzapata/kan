import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";
import { readMeetingContextInput } from "../../../server/src/meeting-schema";
export default defineWorkflowTool({
  description:
    "Read the finalized meeting transcript segments that triggered this run (or an explicit range). Call this first on meeting-context runs.",
  inputSchema: z.object({
    input: readMeetingContextInput,
  }),
  async execute(input, ctx) {
    "use workflow";
    return callMeeting(input, ctx);
  },
});
async function callMeeting(input: any, ctx: WorkflowStepToolContext) {
  "use step";
  ctx.abortSignal.throwIfAborted();
  const response = await fetch(`${process.env.WEB_API_URL}/internal`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.KAN_SERVICE_SECRET}`,
    },
    body: JSON.stringify({
      action: "tool",
      name: "readMeetingContext",
      input: input.input,
      session: ctx.session.id,
      callId: ctx.callId,
    }),
    signal: ctx.abortSignal,
  });
  if (!response.ok)
    throw Error("Authorized tool failed; the meeting context is unavailable.");
  return response.json();
}
