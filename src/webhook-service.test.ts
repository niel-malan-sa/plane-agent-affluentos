import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppDatabase } from "./db.js";
import { buildAgentResponse, extractLatestPrompt, verifyPlaneSignature } from "./webhook-service.js";
import { hmacSha256Hex } from "./utils.js";

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

test("database delivery reservation and prompt dedupe are durable", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-agent-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const db = new AppDatabase(dbPath);

  const firstReservation = db.reserveDelivery({
    deliveryId: "delivery-1",
    event: "agent_run_user_prompt",
    workspaceId: "workspace-1",
    runId: "run-1",
    activityId: "activity-1",
    payloadSha256: "abc123"
  });
  const secondReservation = db.reserveDelivery({
    deliveryId: "delivery-1",
    event: "agent_run_user_prompt",
    workspaceId: "workspace-1",
    runId: "run-1",
    activityId: "activity-1",
    payloadSha256: "abc123"
  });

  assert.equal(firstReservation.accepted, true);
  assert.equal(secondReservation.accepted, false);

  assert.equal(db.isPromptProcessed("activity-1"), false);
  db.markPromptProcessed({
    activityId: "activity-1",
    agentRunId: "run-1",
    workspaceId: "workspace-1",
    promptSha256: "abc123",
    sourceDeliveryId: "delivery-1"
  });
  assert.equal(db.isPromptProcessed("activity-1"), true);
});

test("buildAgentResponse preserves read/respond-only contract", () => {
  const response = buildAgentResponse("Summarize this thread", "run-123");
  assert.match(response, /read\/respond-only mode/i);
  assert.match(response, /run-123/);
});
