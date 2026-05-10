import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.string().min(1).default("info"),
  PLANE_BASE_URL: z.url(),
  PLANE_CLIENT_ID: z.string().min(1),
  PLANE_CLIENT_SECRET: z.string().min(1),
  PLANE_REDIRECT_URI: z.url(),
  PLANE_WEBHOOK_SECRET: z.string().min(1),
  PLANE_OAUTH_SCOPES: z.string().min(1),
  DATABASE_PATH: z.string().min(1).default("./data/plane-agent.sqlite"),
  STATE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  TOKEN_REFRESH_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(700)
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  databasePathAbsolute: string;
  oauthScopes: string[];
};

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.parse(process.env);
  const databasePathAbsolute = path.resolve(parsed.DATABASE_PATH);

  fs.mkdirSync(path.dirname(databasePathAbsolute), { recursive: true });

  return {
    ...parsed,
    databasePathAbsolute,
    oauthScopes: parsed.PLANE_OAUTH_SCOPES.split(/\s+/).filter(Boolean)
  };
}
