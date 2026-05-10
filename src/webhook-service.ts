import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { OpenAIResponder } from "./openai-client.js";
import { PlaneApiClient } from "./plane-api.js";
import type {
  AgentRunActivity,
  AgentRunCreateWebhook,
  AgentRunPromptWebhook,
  DeliveryReservationResult,
  InstallationRecord
} from "./types.js";
import { clipText, hmacSha256Hex, secureCompareHex, sha256Hex } from "./utils.js";

const HANDLED_EVENTS = new Set(["agent_run_create", "agent_run_user_prompt"]);

export function verifyPlaneSignature(payload: Buffer, signature: string, secret: string): boolean {
  return secureCompareHex(hmacSha256Hex(secret, payload), signature);
}

export function extractLatestPrompt(
  activities: AgentRunActivity[],
  botUserId: string
): AgentRunActivity | null {
  const prompts = activities.filter((activity) => {
    return (
      activity.type === "prompt" &&
      typeof activity.content?.body === "string" &&
      activity.actor !== botUserId
    );
  });

  if (prompts.length === 0) {
    return null;
  }

  prompts.sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
    return leftTime - rightTime;
  });

  return prompts.at(-1) ?? null;
}

export function buildAgentResponse(promptBody: string, runId: string): string {
  const trimmed = promptBody.trim();
  return [
    "I received your Plane prompt and reviewed the current Agent Run context.",
    "",
    `Run: ${runId}`,
    "",
    "Latest prompt:",
    trimmed.length > 0 ? `> ${clipText(trimmed, 600)}` : "> [empty prompt]",
    "",
    "This external agent is operating in read/respond-only mode. No Plane records were modified beyond this agent activity reply."
  ].join("\n");
}

export class PlaneWebhookService {
  public constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly planeApi: PlaneApiClient,
    private readonly openAiResponder: OpenAIResponder,
    private readonly logger: Logger
  ) {}

  public reserveDelivery(
    deliveryId: string,
    event: string,
    rawBody: Buffer,
    payload: Record<string, unknown>
  ): DeliveryReservationResult {
    return this.db.reserveDelivery({
      deliveryId,
      event,
      workspaceId: this.extractWorkspaceId(payload),
      runId: this.extractRunId(payload),
      activityId: this.extractActivityId(payload),
      payloadSha256: sha256Hex(rawBody)
    });
  }

  public async processDelivery(
    deliveryId: string,
    event: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!HANDLED_EVENTS.has(event)) {
      this.db.markDeliveryStatus(deliveryId, "ignored");
      return;
    }

    const workspaceId = this.extractWorkspaceId(payload);
    if (!workspaceId) {
      this.db.markDeliveryStatus(deliveryId, "invalid_payload", "Missing workspace_id");
      return;
    }

    const installation = await this.planeApi.getInstallationForWorkspace(workspaceId);
    if (!installation) {
      this.db.markDeliveryStatus(deliveryId, "missing_installation", `No installation for workspace ${workspaceId}`);
      return;
    }

    try {
      if (event === "agent_run_create") {
        await this.handleAgentRunCreate(deliveryId, payload as unknown as AgentRunCreateWebhook, installation);
      } else {
        await this.handleAgentRunPrompt(deliveryId, payload as unknown as AgentRunPromptWebhook, installation);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error({ err: error, deliveryId, event }, "Plane webhook processing failed");
      const runId = this.extractRunId(payload);
      if (runId) {
        await this.postErrorActivity(installation, runId, message);
      }
      this.db.markDeliveryStatus(deliveryId, "failed", message);
    }
  }

  private async handleAgentRunCreate(
    deliveryId: string,
    payload: AgentRunCreateWebhook,
    installation: InstallationRecord
  ): Promise<void> {
    const runId = payload.agent_run?.id;
    if (!runId) {
      this.db.markDeliveryStatus(deliveryId, "invalid_payload", "Missing agent_run.id");
      return;
    }

    await this.processLatestPrompt(deliveryId, runId, installation, null);
  }

  private async handleAgentRunPrompt(
    deliveryId: string,
    payload: AgentRunPromptWebhook,
    installation: InstallationRecord
  ): Promise<void> {
    const runId = payload.agent_run?.id;
    const activityId = payload.agent_run_activity?.id;

    if (!runId || !activityId) {
      this.db.markDeliveryStatus(deliveryId, "invalid_payload", "Missing run or activity id");
      return;
    }

    await this.processLatestPrompt(deliveryId, runId, installation, payload.agent_run_activity);
  }

  private async processLatestPrompt(
    deliveryId: string,
    runId: string,
    installation: InstallationRecord,
    directPrompt: AgentRunActivity | null
  ): Promise<void> {
    const [run, activities] = await Promise.all([
      this.planeApi.getRun(installation.workspaceSlug, runId, installation.botToken),
      this.planeApi.listActivities(installation.workspaceSlug, runId, installation.botToken)
    ]);

    const promptActivity = directPrompt ?? extractLatestPrompt(activities, installation.botUserId);
    if (!promptActivity) {
      this.db.markDeliveryStatus(deliveryId, "waiting_for_prompt");
      return;
    }

    if (this.db.isPromptProcessed(promptActivity.id)) {
      this.db.markDeliveryStatus(deliveryId, "duplicate_prompt");
      return;
    }

    const promptBody = promptActivity.content?.body ?? "";
    const runStatus = (run.status ?? "").toLowerCase();

    if (runStatus === "stopping" || runStatus === "stopped") {
      this.db.markDeliveryStatus(deliveryId, "stopped");
      return;
    }

    if (promptActivity.signal === "stop") {
      await this.planeApi.createActivity(installation.workspaceSlug, run.id, installation.botToken, {
        type: "response",
        signal: "stop",
        content: {
          type: "response",
          body: "Stop signal received. No further processing will be performed."
        }
      });

      this.db.markPromptProcessed({
        activityId: promptActivity.id,
        agentRunId: run.id,
        workspaceId: installation.workspaceId,
        promptSha256: sha256Hex(promptBody),
        sourceDeliveryId: deliveryId
      });
      this.db.markDeliveryStatus(deliveryId, "stopped");
      return;
    }

    await this.planeApi.createActivity(installation.workspaceSlug, run.id, installation.botToken, {
      type: "thought",
      content: {
        type: "thought",
        body: "Reviewing the latest Plane prompt and run context."
      }
    });

    const responseBody = await this.openAiResponder.generateResponse({
      workspaceSlug: installation.workspaceSlug,
      run,
      activities,
      latestPromptBody: promptBody
    });

    await this.planeApi.createActivity(installation.workspaceSlug, run.id, installation.botToken, {
      type: "response",
      signal: "continue",
      content: {
        type: "response",
        body: responseBody
      }
    });

    this.db.markPromptProcessed({
      activityId: promptActivity.id,
      agentRunId: run.id,
      workspaceId: installation.workspaceId,
      promptSha256: sha256Hex(promptBody),
      sourceDeliveryId: deliveryId
    });
    this.db.markDeliveryStatus(deliveryId, "processed");
  }

  private async postErrorActivity(
    installation: InstallationRecord,
    runId: string,
    errorMessage: string
  ): Promise<void> {
    try {
      await this.planeApi.createActivity(installation.workspaceSlug, runId, installation.botToken, {
        type: "error",
        content: {
          type: "error",
          body: `Unable to process the Plane agent request: ${clipText(errorMessage, 400)}`
        }
      });
    } catch (error) {
      this.logger.error({ err: error, runId }, "Failed to post Plane error activity");
    }
  }

  private extractWorkspaceId(payload: Record<string, unknown>): string | null {
    if (typeof payload.workspace_id === "string" && payload.workspace_id.length > 0) {
      return payload.workspace_id;
    }

    const agentRun = payload.agent_run as Record<string, unknown> | undefined;
    if (agentRun && typeof agentRun.workspace === "string") {
      return agentRun.workspace;
    }

    return null;
  }

  private extractRunId(payload: Record<string, unknown>): string | null {
    const agentRun = payload.agent_run as Record<string, unknown> | undefined;
    if (agentRun && typeof agentRun.id === "string") {
      return agentRun.id;
    }

    return null;
  }

  private extractActivityId(payload: Record<string, unknown>): string | null {
    const activity = payload.agent_run_activity as Record<string, unknown> | undefined;
    if (activity && typeof activity.id === "string") {
      return activity.id;
    }

    return null;
  }
}
