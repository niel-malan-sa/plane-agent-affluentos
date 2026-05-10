import { URLSearchParams } from "node:url";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import type {
  AgentRun,
  AgentRunActivity,
  CreateActivityRequest,
  InstallationRecord,
  OAuthTokenResponse,
  PaginatedResults,
  PlaneAppInstallation
} from "./types.js";
import { addSeconds, nowIso } from "./utils.js";

export class PlaneApiError extends Error {
  public readonly status: number;
  public readonly responseText: string;

  public constructor(message: string, status: number, responseText: string) {
    super(message);
    this.name = "PlaneApiError";
    this.status = status;
    this.responseText = responseText;
  }
}

export class PlaneApiClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly logger: Logger
  ) {}

  public async exchangeBotToken(appInstallationId: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      app_installation_id: appInstallationId,
      scope: this.config.oauthScopes.join(" ")
    });

    return this.requestJson<OAuthTokenResponse>("/auth/o/token/", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.config.PLANE_CLIENT_ID}:${this.config.PLANE_CLIENT_SECRET}`
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
  }

  public async getAppInstallation(appInstallationId: string, botToken: string): Promise<PlaneAppInstallation> {
    const installations = await this.requestJson<PlaneAppInstallation[]>(
      `/auth/o/app-installation/?id=${encodeURIComponent(appInstallationId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${botToken}`
        }
      }
    );

    const installation = installations[0];
    if (!installation) {
      throw new Error(`No Plane installation found for ${appInstallationId}`);
    }

    return installation;
  }

  public async finalizeInstallation(appInstallationId: string): Promise<InstallationRecord> {
    const token = await this.exchangeBotToken(appInstallationId);
    const installation = await this.getAppInstallation(appInstallationId, token.access_token);
    const installedAt = nowIso();
    const record: InstallationRecord = {
      appInstallationId,
      workspaceId: installation.workspace,
      workspaceSlug: installation.workspace_detail.slug,
      botUserId: installation.app_bot,
      botToken: token.access_token,
      botTokenExpiresAt: addSeconds(installedAt, token.expires_in),
      scopes: token.scope || this.config.oauthScopes.join(" "),
      status: installation.status,
      installedAt,
      updatedAt: installedAt
    };

    this.db.upsertInstallation(record);
    return record;
  }

  public async getInstallationForWorkspace(workspaceId: string): Promise<InstallationRecord | null> {
    const record = this.db.getInstallationByWorkspaceId(workspaceId);
    if (!record) {
      return null;
    }

    if (Date.parse(record.botTokenExpiresAt) - Date.now() > this.config.TOKEN_REFRESH_SKEW_SECONDS * 1000) {
      return record;
    }

    this.logger.info({ workspaceId, appInstallationId: record.appInstallationId }, "Refreshing Plane bot token");

    const refreshedToken = await this.exchangeBotToken(record.appInstallationId);
    const updatedRecord: InstallationRecord = {
      ...record,
      botToken: refreshedToken.access_token,
      botTokenExpiresAt: addSeconds(nowIso(), refreshedToken.expires_in),
      scopes: refreshedToken.scope || record.scopes,
      updatedAt: nowIso()
    };

    this.db.upsertInstallation(updatedRecord);
    return updatedRecord;
  }

  public async getRun(workspaceSlug: string, runId: string, botToken: string): Promise<AgentRun> {
    return this.requestJson<AgentRun>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/runs/${encodeURIComponent(runId)}/`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${botToken}`
        }
      }
    );
  }

  public async listActivities(
    workspaceSlug: string,
    runId: string,
    botToken: string
  ): Promise<AgentRunActivity[]> {
    const payload = await this.requestJson<AgentRunActivity[] | PaginatedResults<AgentRunActivity>>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/runs/${encodeURIComponent(runId)}/activities/`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${botToken}`
        }
      }
    );

    if (Array.isArray(payload)) {
      return payload;
    }

    return payload.results ?? [];
  }

  public async createActivity(
    workspaceSlug: string,
    runId: string,
    botToken: string,
    payload: CreateActivityRequest
  ): Promise<AgentRunActivity> {
    return this.requestJson<AgentRunActivity>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/runs/${encodeURIComponent(runId)}/activities/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );
  }

  private async requestJson<T>(
    path: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: URLSearchParams | string;
    }
  ): Promise<T> {
    const url = new URL(path, this.config.PLANE_BASE_URL);
    const response = await fetch(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        ...init.headers
      },
      body: init.body
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new PlaneApiError(`Plane API request failed for ${url.pathname}`, response.status, responseText);
    }

    if (responseText.length === 0) {
      return undefined as T;
    }

    return JSON.parse(responseText) as T;
  }
}
