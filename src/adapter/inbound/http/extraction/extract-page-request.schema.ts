import { z } from "zod";

export const extractPageRequestSchema = z
  .object({
    url: z.string().url().max(2_048),
  })
  .strict();

export type ExtractPageRequest = z.infer<typeof extractPageRequestSchema>;
