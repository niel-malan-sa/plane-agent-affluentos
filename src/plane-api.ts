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
  PlaneAppInstallation,
  PlanePage,
  PlaneProject,
  PlaneWorkItem,
  UserTokenRecord
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
      app_installation_id: appInstallationId
    });

    return this.requestJson<OAuthTokenResponse>("/auth/o/token/", {
      method: "POST",
      headers: this.oauthHeaders(),
      body
    });
  }

  public async exchangeUserToken(code: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.PLANE_CLIENT_ID,
      client_secret: this.config.PLANE_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.PLANE_REDIRECT_URI
    });

    return this.requestJson<OAuthTokenResponse>("/auth/o/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
  }

  public async refreshUserToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.PLANE_CLIENT_ID,
      client_secret: this.config.PLANE_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });

    return this.requestJson<OAuthTokenResponse>("/auth/o/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
  }

  public async getAppInstallation(
    appInstallationId: string,
    accessToken: string
  ): Promise<PlaneAppInstallation> {
    const installations = await this.requestJson<PlaneAppInstallation[]>(
      `/auth/o/app-installation/?id=${encodeURIComponent(appInstallationId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }
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
    const timestamp = nowIso();
    const record: InstallationRecord = {
      appInstallationId,
      workspaceId: installation.workspace,
      workspaceSlug: installation.workspace_detail.slug,
      botUserId: installation.app_bot,
      botToken: token.access_token,
      botTokenExpiresAt: addSeconds(timestamp, token.expires_in),
      scopes: token.scope || this.config.oauthScopes.join(" "),
      status: installation.status,
      installedAt: timestamp,
      updatedAt: timestamp,
      lastHealthcheckAt: timestamp,
      lastHealthcheckError: null
    };

    await this.db.upsertInstallation(record);
    return record;
  }

  public async finalizeUserAuthorization(
    workspaceId: string,
    userId: string,
    code: string
  ): Promise<UserTokenRecord> {
    const token = await this.exchangeUserToken(code);
    const timestamp = nowIso();
    const record: UserTokenRecord = {
      workspaceId,
      userId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? "",
      accessTokenExpiresAt: addSeconds(timestamp, token.expires_in),
      scopes: token.scope || this.config.userOauthScopes.join(" "),
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.db.upsertUserToken(record);
    return record;
  }

  public async getInstallationForWorkspace(workspaceId: string): Promise<InstallationRecord | null> {
    const record = await this.db.getInstallationByWorkspaceId(workspaceId);
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

    await this.db.upsertInstallation(updatedRecord);
    return updatedRecord;
  }

  public async getUserTokenForWorkspaceUser(
    workspaceId: string,
    userId: string
  ): Promise<UserTokenRecord | null> {
    const record = await this.db.getUserToken(workspaceId, userId);
    if (!record) {
      return null;
    }

    if (
      Date.parse(record.accessTokenExpiresAt) - Date.now() >
      this.config.TOKEN_REFRESH_SKEW_SECONDS * 1000
    ) {
      return record;
    }

    if (!record.refreshToken) {
      return null;
    }

    this.logger.info({ workspaceId, userId }, "Refreshing Plane user token");
    const refreshedToken = await this.refreshUserToken(record.refreshToken);
    const updatedRecord: UserTokenRecord = {
      ...record,
      accessToken: refreshedToken.access_token,
      refreshToken: refreshedToken.refresh_token ?? record.refreshToken,
      accessTokenExpiresAt: addSeconds(nowIso(), refreshedToken.expires_in),
      scopes: refreshedToken.scope || record.scopes,
      updatedAt: nowIso()
    };

    await this.db.upsertUserToken(updatedRecord);
    return updatedRecord;
  }

  public async healthcheckInstallation(record: InstallationRecord): Promise<InstallationRecord> {
    try {
      const installation = await this.getAppInstallation(record.appInstallationId, record.botToken);
      const updatedRecord: InstallationRecord = {
        ...record,
        status: installation.status,
        workspaceSlug: installation.workspace_detail.slug,
        lastHealthcheckAt: nowIso(),
        lastHealthcheckError: null,
        updatedAt: nowIso()
      };
      await this.db.upsertInstallation(updatedRecord);
      return updatedRecord;
    } catch (error) {
      const updatedRecord: InstallationRecord = {
        ...record,
        lastHealthcheckAt: nowIso(),
        lastHealthcheckError: error instanceof Error ? error.message : "Unknown healthcheck error",
        updatedAt: nowIso()
      };
      await this.db.upsertInstallation(updatedRecord);
      throw error;
    }
  }

  public async getRun(workspaceSlug: string, runId: string, botToken: string): Promise<AgentRun> {
    return this.requestJson<AgentRun>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/runs/${encodeURIComponent(runId)}/`,
      { method: "GET", headers: { Authorization: `Bearer ${botToken}` } }
    );
  }

  public async listActivities(
    workspaceSlug: string,
    runId: string,
    botToken: string
  ): Promise<AgentRunActivity[]> {
    const payload = await this.requestJson<AgentRunActivity[] | PaginatedResults<AgentRunActivity>>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/runs/${encodeURIComponent(runId)}/activities/`,
      { method: "GET", headers: { Authorization: `Bearer ${botToken}` } }
    );

    return Array.isArray(payload) ? payload : payload.results ?? [];
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

  public async listProjects(workspaceSlug: string, token: string): Promise<PlaneProject[]> {
    const payload = await this.requestJson<PlaneProject[] | PaginatedResults<PlaneProject>>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } }
    );
    return Array.isArray(payload) ? payload : payload.results ?? [];
  }

  public async getWorkItem(
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    token: string
  ): Promise<PlaneWorkItem> {
    return this.requestJson<PlaneWorkItem>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } }
    );
  }

  public async listWorkItems(
    workspaceSlug: string,
    projectId: string,
    token: string
  ): Promise<PlaneWorkItem[]> {
    const payload = await this.requestJson<PlaneWorkItem[] | PaginatedResults<PlaneWorkItem>>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } }
    );
    return Array.isArray(payload) ? payload : payload.results ?? [];
  }

  public async createWorkItem(
    workspaceSlug: string,
    projectId: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<PlaneWorkItem> {
    return this.requestJson<PlaneWorkItem>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
  }

  public async updateWorkItem(
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<PlaneWorkItem> {
    return this.requestJson<PlaneWorkItem>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
  }

  public async createComment(
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/comments/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
  }

  public async createProjectPage(
    workspaceSlug: string,
    projectId: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<PlanePage> {
    return this.requestJson<PlanePage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/pages/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
  }

  public async createWikiPage(
    workspaceSlug: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<PlanePage> {
    return this.requestJson<PlanePage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/pages/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
  }

  public async createLink(
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/links/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
  }

  private oauthHeaders(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(
        `${this.config.PLANE_CLIENT_ID}:${this.config.PLANE_CLIENT_SECRET}`
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    };
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
      headers: { Accept: "application/json", ...init.headers },
      body: init.body
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new PlaneApiError(`Plane API request failed for ${url.pathname}`, response.status, responseText);
    }

    if (!responseText) {
      return undefined as T;
    }

    return JSON.parse(responseText) as T;
  }
}
