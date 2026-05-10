import Database from "better-sqlite3";
import { nowIso } from "./utils.js";
import type {
  DeliveryRecordInput,
  DeliveryReservationResult,
  InstallationRecord
} from "./types.js";

export class AppDatabase {
  private readonly db: Database.Database;

  public constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  public healthcheck(): boolean {
    const row = this.db.prepare("SELECT 1 AS ok").get() as { ok: number };
    return row.ok === 1;
  }

  public saveOauthState(state: string): void {
    const createdAt = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO oauth_states (state, created_at)
          VALUES (?, ?)
          ON CONFLICT(state) DO UPDATE SET created_at = excluded.created_at
        `
      )
      .run(state, createdAt);
  }

  public consumeOauthState(state: string, ttlSeconds: number): boolean {
    const row = this.db
      .prepare("SELECT created_at FROM oauth_states WHERE state = ?")
      .get(state) as { created_at: string } | undefined;

    if (!row) {
      return false;
    }

    const expiresAt = Date.parse(row.created_at) + ttlSeconds * 1000;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    return expiresAt >= Date.now();
  }

  public purgeExpiredOauthStates(ttlSeconds: number): void {
    const cutoff = new Date(Date.now() - ttlSeconds * 1000).toISOString();
    this.db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(cutoff);
  }

  public upsertInstallation(record: InstallationRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO installations (
            app_installation_id,
            workspace_id,
            workspace_slug,
            bot_user_id,
            bot_token,
            bot_token_expires_at,
            scopes,
            status,
            installed_at,
            updated_at
          ) VALUES (
            @appInstallationId,
            @workspaceId,
            @workspaceSlug,
            @botUserId,
            @botToken,
            @botTokenExpiresAt,
            @scopes,
            @status,
            @installedAt,
            @updatedAt
          )
          ON CONFLICT(app_installation_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            workspace_slug = excluded.workspace_slug,
            bot_user_id = excluded.bot_user_id,
            bot_token = excluded.bot_token,
            bot_token_expires_at = excluded.bot_token_expires_at,
            scopes = excluded.scopes,
            status = excluded.status,
            updated_at = excluded.updated_at
        `
      )
      .run(record);
  }

  public getInstallationByWorkspaceId(workspaceId: string): InstallationRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            app_installation_id AS appInstallationId,
            workspace_id AS workspaceId,
            workspace_slug AS workspaceSlug,
            bot_user_id AS botUserId,
            bot_token AS botToken,
            bot_token_expires_at AS botTokenExpiresAt,
            scopes,
            status,
            installed_at AS installedAt,
            updated_at AS updatedAt
          FROM installations
          WHERE workspace_id = ?
        `
      )
      .get(workspaceId) as InstallationRecord | undefined;

    return row ?? null;
  }

  public reserveDelivery(input: DeliveryRecordInput): DeliveryReservationResult {
    const receivedAt = nowIso();
    const result = this.db
      .prepare(
        `
          INSERT OR IGNORE INTO webhook_deliveries (
            delivery_id,
            event,
            workspace_id,
            run_id,
            activity_id,
            payload_sha256,
            status,
            received_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
        `
      )
      .run(
        input.deliveryId,
        input.event,
        input.workspaceId,
        input.runId,
        input.activityId,
        input.payloadSha256,
        receivedAt
      );

    if (result.changes === 1) {
      return { accepted: true };
    }

    const existing = this.db
      .prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?")
      .get(input.deliveryId) as { status: string } | undefined;

    return {
      accepted: false,
      existingStatus: existing?.status ?? "duplicate"
    };
  }

  public markDeliveryStatus(
    deliveryId: string,
    status: string,
    errorText?: string | null
  ): void {
    this.db
      .prepare(
        `
          UPDATE webhook_deliveries
          SET status = ?,
              error_text = ?,
              processed_at = ?
          WHERE delivery_id = ?
        `
      )
      .run(status, errorText ?? null, nowIso(), deliveryId);
  }

  public isPromptProcessed(activityId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM processed_prompt_activities WHERE activity_id = ?")
      .get(activityId) as { ok: number } | undefined;

    return row?.ok === 1;
  }

  public markPromptProcessed(input: {
    activityId: string;
    agentRunId: string;
    workspaceId: string;
    promptSha256: string;
    sourceDeliveryId: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO processed_prompt_activities (
            activity_id,
            agent_run_id,
            workspace_id,
            prompt_sha256,
            source_delivery_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.activityId,
        input.agentRunId,
        input.workspaceId,
        input.promptSha256,
        input.sourceDeliveryId,
        nowIso()
      );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installations (
        app_installation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        workspace_slug TEXT NOT NULL,
        bot_user_id TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        bot_token_expires_at TEXT NOT NULL,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        workspace_id TEXT,
        run_id TEXT,
        activity_id TEXT,
        payload_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        error_text TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS processed_prompt_activities (
        activity_id TEXT PRIMARY KEY,
        agent_run_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        source_delivery_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
}
