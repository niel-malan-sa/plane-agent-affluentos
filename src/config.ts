import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const optionalNonEmptyString = () =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().min(1).optional()
  );

const EnvSchema = z.object({
  APP_ROLE: z.enum(["all", "ingress", "worker"]).default("all"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.string().min(1).default("info"),
  PUBLIC_BASE_URL: z.url(),
  PLANE_BASE_URL: z.url(),
  PLANE_CLIENT_ID: z.string().min(1),
  PLANE_CLIENT_SECRET: z.string().min(1),
  PLANE_REDIRECT_URI: z.url(),
  PLANE_WEBHOOK_SECRET: z.string().min(1),
  PLANE_OAUTH_SCOPES: z.string().min(1),
  PLANE_USER_OAUTH_SCOPES: z.string().min(1).optional().default("profile:read"),
  DATABASE_URL: optionalNonEmptyString(),
  DATABASE_PATH: z.string().min(1).default("./data/plane-agent.sqlite"),
  STATE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  TOKEN_REFRESH_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  OPENAI_API_KEY: optionalNonEmptyString(),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(900),
  OPENAI_MAX_TOOL_STEPS: z.coerce.number().int().positive().default(3),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  RUN_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(8000),
  RUN_STALE_AFTER_MS: z.coerce.number().int().positive().default(300000),
  MAX_WRITES_PER_RUN: z.coerce.number().int().positive().default(5),
  ENABLE_AUTONOMOUS_WRITES: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true")
    .default(false),
  WRITE_KILL_SWITCH: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true")
    .default(false),
  PROJECT_ALLOWLIST: z.string().optional().default(""),
  PROJECT_BLOCKLIST: z.string().optional().default(""),
  EXTERNAL_AUTH_GITHUB_URL: z.url().optional(),
  EXTERNAL_AUTH_DOCS_URL: z.url().optional()
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  databasePathAbsolute: string;
  oauthScopes: string[];
  userOauthScopes: string[];
  projectAllowlist: Set<string>;
  projectBlocklist: Set<string>;
  databaseMode: "sqlite" | "postgres";
};

function parseList(input: string): Set<string> {
  return new Set(
    input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.parse(process.env);
  const databasePathAbsolute = path.resolve(parsed.DATABASE_PATH);

  if (parsed.APP_ROLE !== "all" && !parsed.DATABASE_URL) {
    throw new Error("Split ingress/worker deployments require DATABASE_URL so both roles share runtime state.");
  }

  if ((parsed.APP_ROLE === "all" || parsed.APP_ROLE === "worker") && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when the worker role is enabled.");
  }

  if (!parsed.DATABASE_URL) {
    fs.mkdirSync(path.dirname(databasePathAbsolute), { recursive: true });
  }

  return {
    ...parsed,
    databasePathAbsolute,
    oauthScopes: parsed.PLANE_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
    userOauthScopes: parsed.PLANE_USER_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
    projectAllowlist: parseList(parsed.PROJECT_ALLOWLIST),
    projectBlocklist: parseList(parsed.PROJECT_BLOCKLIST),
    databaseMode: parsed.DATABASE_URL ? "postgres" : "sqlite"
  };
}
