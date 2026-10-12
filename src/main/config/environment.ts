import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  OPENAI_API_KEY: z.string().min(1),
  ENABLE_CHROME_DEVTOOLS_MCP: booleanString,
  PAGE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  MAX_IMAGES: z.coerce.number().int().min(1).max(200).default(60),
  MAX_CONTENT_NODES: z.coerce.number().int().min(10).max(500).default(180),
  MAX_PAGE_TEXT_CHARS: z.coerce.number().int().min(5_000).max(100_000).default(100_000),
  CONFIRM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.97),
});

export type Environment = z.infer<typeof environmentSchema>;

export const loadEnvironment = (source: NodeJS.ProcessEnv = process.env): Environment =>
  environmentSchema.parse(source);
