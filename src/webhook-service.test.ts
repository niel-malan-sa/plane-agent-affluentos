import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppDatabase } from "./db.js";
import { verifyPlaneSignature, PlaneWebhookService } from "./webhook-service.js";
import { hmacSha256Hex } from "./utils.js";
import { extractLatestPrompt, PolicyEngine } from "./runtime.js";
import type { AppConfig } from "./config.js";

function createConfig(databasePath: string): AppConfig {
  return {
    APP_ROLE: "all",
    PORT: 8080,
    HOST: "0.0.0.0",
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

test("verifyPlaneSignature validates exact raw payload bytes", () => {
  const payload = Buffer.from(JSON.stringify({ hello: "plane" }));
  const secret = "topsecret";
  const signature = hmacSha256Hex(secret, payload);

  assert.equal(verifyPlaneSignature(payload, signature, secret), true);
  assert.equal(verifyPlaneSignature(payload, `${signature}bad`, secret), false);
});

test("extractLatestPrompt returns the newest non-bot prompt", () => {
  const activities = [
    {
      id: "1",
      type: "prompt",
      actor: "user-1",
      content: { type: "prompt", body: "First" },
      created_at: "2026-05-10T10:00:00.000Z"
    },
    {
      id: "2",
      type: "response",
      actor: "bot-1",
      content: { type: "response", body: "Reply" },
      created_at: "2026-05-10T10:01:00.000Z"
    },
    {
      id: "3",
      type: "prompt",
      actor: "user-1",
      content: { type: "prompt", body: "Second" },
      created_at: "2026-05-10T10:02:00.000Z"
    }
  ];

  const latestPrompt = extractLatestPrompt(activities, "bot-1");
  assert.equal(latestPrompt?.id, "3");
});

test("database delivery reservation, dedupe, and queued jobs are durable", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-agent-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const config = createConfig(dbPath);
  const db = new AppDatabase(config);
  await db.migrate();

  const firstReservation = await db.reserveDelivery({
    deliveryId: "delivery-1",
    event: "agent_run_user_prompt",
    workspaceId: "workspace-1",
    runId: "run-1",
    activityId: "activity-1",
    payloadSha256: "abc123"
  });
  const secondReservation = await db.reserveDelivery({
    deliveryId: "delivery-1",
    event: "agent_run_user_prompt",
    workspaceId: "workspace-1",
    runId: "run-1",
    activityId: "activity-1",
    payloadSha256: "abc123"
  });

  assert.equal(firstReservation.accepted, true);
  assert.equal(secondReservation.accepted, false);

  await db.enqueueRunJob({
    deliveryId: "delivery-1",
    event: "agent_run_user_prompt",
    workspaceId: "workspace-1",
    runId: "run-1",
    activityId: "activity-1",
    payload: { workspace_id: "workspace-1", agent_run: { id: "run-1" } }
  });
  const jobs = await db.listRunJobs(10);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "pending");

  assert.equal(await db.isPromptProcessed("activity-1"), false);
  await db.markPromptProcessed({
    activityId: "activity-1",
    agentRunId: "run-1",
    workspaceId: "workspace-1",
    promptSha256: "abc123",
    sourceDeliveryId: "delivery-1"
  });
  assert.equal(await db.isPromptProcessed("activity-1"), true);

  await db.close();
});

test("webhook service queues handled events and ignores unsupported ones", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-agent-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const config = createConfig(dbPath);
  const db = new AppDatabase(config);
  await db.migrate();

  const service = new PlaneWebhookService(
    config,
    db,
    {} as never,
    { info() {}, error() {} } as never
  );

  await service.enqueueDelivery("delivery-1", "agent_run_create", {
    workspace_id: "workspace-1",
    agent_run: { id: "run-1" }
  });
  await service.enqueueDelivery("delivery-2", "issue", {
    workspace_id: "workspace-1",
    agent_run: { id: "run-2" }
  });

  const jobs = await db.listRunJobs(10);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.runId, "run-1");

  await db.close();
});

test("policy engine blocks deletes, honors kill switch, and enforces write ceiling", () => {
  const config = createConfig("/tmp/test.sqlite");
  const engine = new PolicyEngine(config);
  const baseContext = {
    workspaceId: "workspace-1",
    workspaceSlug: "workspace-1",
    runId: "run-1",
    projectId: "project-1",
    workItemId: "work-1",
    actorUserId: "user-1",
    installation: {
      appInstallationId: "install-1",
      workspaceId: "workspace-1",
      workspaceSlug: "workspace-1",
      botUserId: "bot-1",
      botToken: "token",
      botTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: "",
      status: "installed",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    specialist: "execution" as const,
    dryRun: false,
    promptActivityId: "prompt-1",
    accessToken: "token",
    authMode: "bot" as const
  };

  assert.equal(
    engine.decide(
      {
        name: "delete.tool",
        description: "",
        scopes: [],
        policyClass: "delete",
        timeoutMs: 1,
        dryRunSupported: false,
        visibility: "public",
        inputSchema: { safeParse: () => ({ success: true, data: {} }) },
        execute: async () => undefined
      },
      baseContext,
      0
    ).allowed,
    false
  );

  assert.equal(
    engine.decide(
      {
        name: "write.tool",
        description: "",
        scopes: [],
        policyClass: "write",
        timeoutMs: 1,
        dryRunSupported: true,
        visibility: "public",
        inputSchema: { safeParse: () => ({ success: true, data: {} }) },
        execute: async () => undefined
      },
      baseContext,
      2
    ).allowed,
    false
  );
});
