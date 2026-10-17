import { z } from "zod";
export const readMeetingContextInput = z.object({
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
