import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { createServer } from "./server.js";
import { AppDatabase } from "./db.js";
import type { AppConfig } from "./config.js";
import { hmacSha256Hex } from "./utils.js";

function createConfig(databasePath: string): AppConfig {
  return {
    APP_ROLE: "all",
    PORT: 0,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://plane-agent.affluentos.com",
    PLANE_BASE_URL: "https://plane.affluentos.com",
    PLANE_CLIENT_ID: "client-id",
    PLANE_CLIENT_SECRET: "client-secret",
    PLANE_REDIRECT_URI: "https://plane-agent.affluentos.com/oauth/callback",
    PLANE_WEBHOOK_SECRET: "secret",
    PLANE_OAUTH_SCOPES: "agents.runs:read agents.run_activities:write",
    PLANE_USER_OAUTH_SCOPES: "profile:read",
    DATABASE_PATH: databasePath,
    DATABASE_URL: undefined,
    STATE_TTL_SECONDS: 900,
    TOKEN_REFRESH_SKEW_SECONDS: 300,
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "gpt-4.1-mini",
    OPENAI_TIMEOUT_MS: 30000,
    OPENAI_MAX_OUTPUT_TOKENS: 900,
    OPENAI_MAX_TOOL_STEPS: 3,
    WORKER_POLL_INTERVAL_MS: 1000,
    WORKER_CONCURRENCY: 1,
    RUN_HEARTBEAT_INTERVAL_MS: 8000,
    RUN_STALE_AFTER_MS: 300000,
    MAX_WRITES_PER_RUN: 2,
    ENABLE_AUTONOMOUS_WRITES: true,
    WRITE_KILL_SWITCH: false,
    PROJECT_ALLOWLIST: "",
    PROJECT_BLOCKLIST: "",
    EXTERNAL_AUTH_GITHUB_URL: undefined,
    EXTERNAL_AUTH_DOCS_URL: undefined,
    databasePathAbsolute: databasePath,
    oauthScopes: ["agents.runs:read", "agents.run_activities:write"],
    userOauthScopes: ["profile:read"],
    projectAllowlist: new Set(),
    projectBlocklist: new Set(),
    databaseMode: "sqlite"
  };
}

test("webhook route validates signature on raw body and queues a job", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-agent-server-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const config = createConfig(dbPath);
  const db = new AppDatabase(config);
  await db.migrate();

  const app = createServer(
    config,
    db,
    {} as never,
    { getScopeMatrix: () => [] } as never,
    pino({ level: "silent" })
  );

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const body = JSON.stringify({
    workspace_id: "workspace-1",
    agent_run: { id: "run-1" }
  });
  const response = await fetch(`${baseUrl}/webhooks/plane`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Plane-Signature": hmacSha256Hex(config.PLANE_WEBHOOK_SECRET, Buffer.from(body)),
      "X-Plane-Delivery": "delivery-1",
      "X-Plane-Event": "agent_run_create"
    },
    body
  });

  assert.equal(response.status, 200);
  const jobs = await db.listRunJobs(10);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.deliveryId, "delivery-1");

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await db.close();
});

test("user token connect route creates oauth state and redirects to Plane authorize endpoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-agent-server-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const config = createConfig(dbPath);
  const db = new AppDatabase(config);
  await db.migrate();

  const app = createServer(
    config,
    db,
    {} as never,
    { getScopeMatrix: () => [] } as never,
    pino({ level: "silent" })
  );

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(
    `${baseUrl}/oauth/user/connect?workspaceId=workspace-1&userId=user-1`,
    { redirect: "manual" }
  );

  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const url = new URL(location);
  assert.match(url.pathname, /\/auth\/o\/authorize-app\//);
  assert.equal(url.searchParams.get("scope"), null);
  assert.ok(url.searchParams.get("state"));

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await db.close();
});

test("setup route creates install oauth state and redirects without scope param", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-agent-server-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const config = createConfig(dbPath);
  const db = new AppDatabase(config);
  await db.migrate();

  const app = createServer(
    config,
    db,
    {} as never,
    { getScopeMatrix: () => [] } as never,
    pino({ level: "silent" })
  );

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/setup`, { redirect: "manual" });

  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const url = new URL(location);
  assert.match(url.pathname, /\/auth\/o\/authorize-app\//);
  assert.equal(url.searchParams.get("scope"), null);
  assert.ok(url.searchParams.get("state"));

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await db.close();
});
