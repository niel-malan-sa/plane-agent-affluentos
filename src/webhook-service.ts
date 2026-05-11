import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { PlaneApiClient } from "./plane-api.js";
import type { DeliveryReservationResult, QueueJobPayload } from "./types.js";
import { hmacSha256Hex, secureCompareHex, sha256Hex } from "./utils.js";

const HANDLED_EVENTS = new Set(["agent_run_create", "agent_run_user_prompt"]);

export function verifyPlaneSignature(payload: Buffer, signature: string, secret: string): boolean {
  return secureCompareHex(hmacSha256Hex(secret, payload), signature);
}

export class PlaneWebhookService {
  public constructor(
    private readonly _config: AppConfig,
    private readonly db: AppDatabase,
    private readonly _planeApi: PlaneApiClient,
    private readonly _logger: Logger
  ) {}

  public async reserveDelivery(
    deliveryId: string,
    event: string,
    rawBody: Buffer,
    payload: Record<string, unknown>
  ): Promise<DeliveryReservationResult> {
    return this.db.reserveDelivery({
      deliveryId,
      event,
      workspaceId: this.extractWorkspaceId(payload),
      runId: this.extractRunId(payload),
      activityId: this.extractActivityId(payload),
      payloadSha256: sha256Hex(rawBody)
    });
  }

  public async enqueueDelivery(
    deliveryId: string,
    event: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!HANDLED_EVENTS.has(event)) {
      await this.db.markDeliveryStatus(deliveryId, "ignored");
      return;
    }

    const workspaceId = this.extractWorkspaceId(payload);
    const runId = this.extractRunId(payload);
    if (!workspaceId || !runId) {
      await this.db.markDeliveryStatus(deliveryId, "invalid_payload", "Missing workspace_id or run_id");
      return;
    }

    const jobPayload: QueueJobPayload = {
      deliveryId,
      event,
      workspaceId,
      runId,
      activityId: this.extractActivityId(payload),
      payload
    };

    await this.db.enqueueRunJob(jobPayload);
    await this.db.markDeliveryStatus(deliveryId, "queued");
  }

  private extractWorkspaceId(payload: Record<string, unknown>): string | null {
    if (typeof payload.workspace_id === "string" && payload.workspace_id.length > 0) {
      return payload.workspace_id;
    }

    const agentRun = payload.agent_run;
    if (agentRun && typeof agentRun === "object" && typeof (agentRun as { workspace?: unknown }).workspace === "string") {
      return (agentRun as { workspace: string }).workspace;
    }

    return null;
  }

  private extractRunId(payload: Record<string, unknown>): string | null {
    const agentRun = payload.agent_run;
    if (agentRun && typeof agentRun === "object" && typeof (agentRun as { id?: unknown }).id === "string") {
      return (agentRun as { id: string }).id;
    }
    return null;
  }

  private extractActivityId(payload: Record<string, unknown>): string | null {
    const activity = payload.agent_run_activity;
    if (activity && typeof activity === "object" && typeof (activity as { id?: unknown }).id === "string") {
      return (activity as { id: string }).id;
    }
    return null;
  }
}
