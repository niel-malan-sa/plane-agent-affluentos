import Database from "better-sqlite3";
import { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { nowIso, randomId } from "./utils.js";
import type {
  AuditLogRecord,
  DeliveryRecordInput,
  DeliveryReservationResult,
  InstallationRecord,
  QueueJobPayload,
  RunJobRecord,
  RunMemoryRecord,
  RunStateRecord,
  UserTokenRecord
} from "./types.js";

type RowRecord = Record<string, unknown>;
type RunResult = { changes: number };

function mapJobRow(row: RowRecord): RunJobRecord {
  return {
    jobId: String(row.job_id),
    deliveryId: String(row.delivery_id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    activityId: row.activity_id ? String(row.activity_id) : null,
    event: String(row.event),
    payloadJson: String(row.payload_json),
    status: row.status as RunJobRecord["status"],
    attemptCount: Number(row.attempt_count),
    scheduledAt: String(row.scheduled_at),
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    workerId: row.worker_id ? String(row.worker_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class AppDatabase {
  private readonly sqlite?: Database.Database;
  private readonly pool?: Pool;
  private readonly mode: "sqlite" | "postgres";

  public constructor(private readonly config: AppConfig) {
    this.mode = config.databaseMode;

    if (config.databaseMode === "postgres") {
      this.pool = new Pool({ connectionString: config.DATABASE_URL });
    } else {
      this.sqlite = new Database(config.databasePathAbsolute);
      this.sqlite.pragma("journal_mode = WAL");
      this.sqlite.pragma("foreign_keys = ON");
    }
  }

  public async migrate(): Promise<void> {
    if (this.mode === "postgres") {
      await this.execMany([
        `CREATE TABLE IF NOT EXISTS oauth_states (
          state TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          metadata_json TEXT,
          created_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS installations (
          app_installation_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL UNIQUE,
          workspace_slug TEXT NOT NULL,
          bot_user_id TEXT NOT NULL,
          bot_token TEXT NOT NULL,
          bot_token_expires_at TIMESTAMPTZ NOT NULL,
          scopes TEXT NOT NULL,
          status TEXT NOT NULL,
          installed_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          last_healthcheck_at TIMESTAMPTZ,
          last_healthcheck_error TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS user_tokens (
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          access_token_expires_at TIMESTAMPTZ NOT NULL,
          scopes TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        )`,
        `CREATE TABLE IF NOT EXISTS webhook_deliveries (
          delivery_id TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          workspace_id TEXT,
          run_id TEXT,
          activity_id TEXT,
          payload_sha256 TEXT NOT NULL,
          status TEXT NOT NULL,
          error_text TEXT,
          received_at TIMESTAMPTZ NOT NULL,
          processed_at TIMESTAMPTZ
        )`,
        `CREATE TABLE IF NOT EXISTS processed_prompt_activities (
          activity_id TEXT PRIMARY KEY,
          agent_run_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          prompt_sha256 TEXT NOT NULL,
          source_delivery_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS run_jobs (
          job_id TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          activity_id TEXT,
          event TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          scheduled_at TIMESTAMPTZ NOT NULL,
          claimed_at TIMESTAMPTZ,
          heartbeat_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          last_error TEXT,
          worker_id TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS run_states (
          run_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          workspace_slug TEXT NOT NULL,
          specialist TEXT NOT NULL,
          status TEXT NOT NULL,
          write_count INTEGER NOT NULL,
          last_prompt_activity_id TEXT,
          summary TEXT,
          project_id TEXT,
          work_item_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS run_memory (
          memory_key TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT,
          object_id TEXT,
          summary TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          policy_class TEXT NOT NULL,
          status TEXT NOT NULL,
          request_json TEXT NOT NULL,
          response_json TEXT,
          error_text TEXT,
          created_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS tool_executions (
          dedupe_key TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          prompt_activity_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL,
          request_json TEXT NOT NULL,
          response_json TEXT,
          error_text TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )`
      ]);
      return;
    }

    this.sqlite?.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        metadata_json TEXT,
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
        updated_at TEXT NOT NULL,
        last_healthcheck_at TEXT,
        last_healthcheck_error TEXT
      );

      CREATE TABLE IF NOT EXISTS user_tokens (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_token_expires_at TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
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

      CREATE TABLE IF NOT EXISTS run_jobs (
        job_id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        activity_id TEXT,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        scheduled_at TEXT NOT NULL,
        claimed_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_states (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_slug TEXT NOT NULL,
        specialist TEXT NOT NULL,
        status TEXT NOT NULL,
        write_count INTEGER NOT NULL,
        last_prompt_activity_id TEXT,
        summary TEXT,
        project_id TEXT,
        work_item_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_memory (
        memory_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        object_id TEXT,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        policy_class TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        dedupe_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        prompt_activity_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureSqliteColumn("oauth_states", "mode", "TEXT NOT NULL DEFAULT 'install'");
    this.ensureSqliteColumn("oauth_states", "metadata_json", "TEXT");
    this.ensureSqliteColumn("installations", "last_healthcheck_at", "TEXT");
    this.ensureSqliteColumn("installations", "last_healthcheck_error", "TEXT");
  }

  public async close(): Promise<void> {
    await this.pool?.end();
    this.sqlite?.close();
  }

  public async healthcheck(): Promise<boolean> {
    const row = await this.get<{ ok: number }>("SELECT 1 AS ok");
    return row?.ok === 1;
  }

  public async countActiveJobs(): Promise<number> {
    const row = await this.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_jobs WHERE status IN ('pending', 'retry', 'running')"
    );
    return Number(row?.count ?? 0);
  }

  public async saveOauthState(
    state: string,
    mode: "install" | "user_token" = "install",
    metadataJson: string | null = null
  ): Promise<void> {
    const createdAt = nowIso();
    await this.run(
      `
        INSERT INTO oauth_states (state, mode, metadata_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(state) DO UPDATE SET
          mode = excluded.mode,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      `,
      [state, mode, metadataJson, createdAt]
    );
  }

  public async consumeOauthState(
    state: string,
    ttlSeconds: number
  ): Promise<{ valid: boolean; mode: string | null; metadataJson: string | null }> {
    const row = await this.get<{ created_at: string; mode: string; metadata_json: string | null }>(
      "SELECT created_at, mode, metadata_json FROM oauth_states WHERE state = ?",
      [state]
    );

    if (!row) {
      return { valid: false, mode: null, metadataJson: null };
    }

    await this.run("DELETE FROM oauth_states WHERE state = ?", [state]);
    const expiresAt = Date.parse(row.created_at) + ttlSeconds * 1000;
    return {
      valid: expiresAt >= Date.now(),
      mode: row.mode,
      metadataJson: row.metadata_json
    };
  }

  public async purgeExpiredOauthStates(ttlSeconds: number): Promise<void> {
    const cutoff = new Date(Date.now() - ttlSeconds * 1000).toISOString();
    await this.run("DELETE FROM oauth_states WHERE created_at < ?", [cutoff]);
  }

  public async upsertInstallation(record: InstallationRecord): Promise<void> {
    await this.run(
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
          updated_at,
          last_healthcheck_at,
          last_healthcheck_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_installation_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          workspace_slug = excluded.workspace_slug,
          bot_user_id = excluded.bot_user_id,
          bot_token = excluded.bot_token,
          bot_token_expires_at = excluded.bot_token_expires_at,
          scopes = excluded.scopes,
          status = excluded.status,
          updated_at = excluded.updated_at,
          last_healthcheck_at = excluded.last_healthcheck_at,
          last_healthcheck_error = excluded.last_healthcheck_error
      `,
      [
        record.appInstallationId,
        record.workspaceId,
        record.workspaceSlug,
        record.botUserId,
        record.botToken,
        record.botTokenExpiresAt,
        record.scopes,
        record.status,
        record.installedAt,
        record.updatedAt,
        record.lastHealthcheckAt ?? null,
        record.lastHealthcheckError ?? null
      ]
    );
  }

  public async getInstallationByWorkspaceId(workspaceId: string): Promise<InstallationRecord | null> {
    const row = await this.get<RowRecord>(
      `
        SELECT
          app_installation_id,
          workspace_id,
          workspace_slug,
          bot_user_id,
          bot_token,
          bot_token_expires_at,
          scopes,
          status,
          installed_at,
          updated_at,
          last_healthcheck_at,
          last_healthcheck_error
        FROM installations
        WHERE workspace_id = ?
      `,
      [workspaceId]
    );

    return row ? this.mapInstallation(row) : null;
  }

  public async getInstallationByAppInstallationId(
    appInstallationId: string
  ): Promise<InstallationRecord | null> {
    const row = await this.get<RowRecord>(
      `
        SELECT
          app_installation_id,
          workspace_id,
          workspace_slug,
          bot_user_id,
          bot_token,
          bot_token_expires_at,
          scopes,
          status,
          installed_at,
          updated_at,
          last_healthcheck_at,
          last_healthcheck_error
        FROM installations
        WHERE app_installation_id = ?
      `,
      [appInstallationId]
    );

    return row ? this.mapInstallation(row) : null;
  }

  public async upsertUserToken(record: UserTokenRecord): Promise<void> {
    await this.run(
      `
        INSERT INTO user_tokens (
          workspace_id,
          user_id,
          access_token,
          refresh_token,
          access_token_expires_at,
          scopes,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          access_token_expires_at = excluded.access_token_expires_at,
          scopes = excluded.scopes,
          updated_at = excluded.updated_at
      `,
      [
        record.workspaceId,
        record.userId,
        record.accessToken,
        record.refreshToken,
        record.accessTokenExpiresAt,
        record.scopes,
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  public async getUserToken(workspaceId: string, userId: string): Promise<UserTokenRecord | null> {
    const row = await this.get<RowRecord>(
      `
        SELECT
          workspace_id,
          user_id,
          access_token,
          refresh_token,
          access_token_expires_at,
          scopes,
          created_at,
          updated_at
        FROM user_tokens
        WHERE workspace_id = ? AND user_id = ?
      `,
      [workspaceId, userId]
    );

    if (!row) {
      return null;
    }

    return {
      workspaceId: String(row.workspace_id),
      userId: String(row.user_id),
      accessToken: String(row.access_token),
      refreshToken: String(row.refresh_token),
      accessTokenExpiresAt: String(row.access_token_expires_at),
      scopes: String(row.scopes),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  public async reserveDelivery(input: DeliveryRecordInput): Promise<DeliveryReservationResult> {
    const receivedAt = nowIso();
    const inserted = await this.insertIgnore(
      "webhook_deliveries",
      `
        INSERT INTO webhook_deliveries (
          delivery_id,
          event,
          workspace_id,
          run_id,
          activity_id,
          payload_sha256,
          status,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
      `,
      [
        input.deliveryId,
        input.event,
        input.workspaceId,
        input.runId,
        input.activityId,
        input.payloadSha256,
        receivedAt
      ]
    );

    if (inserted) {
      return { accepted: true };
    }

    const existing = await this.get<{ status: string }>(
      "SELECT status FROM webhook_deliveries WHERE delivery_id = ?",
      [input.deliveryId]
    );
    return { accepted: false, existingStatus: existing?.status ?? "duplicate" };
  }

  public async markDeliveryStatus(
    deliveryId: string,
    status: string,
    errorText?: string | null
  ): Promise<void> {
    await this.run(
      `
        UPDATE webhook_deliveries
        SET status = ?, error_text = ?, processed_at = ?
        WHERE delivery_id = ?
      `,
      [status, errorText ?? null, nowIso(), deliveryId]
    );
  }

  public async isPromptProcessed(activityId: string): Promise<boolean> {
    const row = await this.get<{ ok: number }>(
      "SELECT 1 AS ok FROM processed_prompt_activities WHERE activity_id = ?",
      [activityId]
    );
    return row?.ok === 1;
  }

  public async markPromptProcessed(input: {
    activityId: string;
    agentRunId: string;
    workspaceId: string;
    promptSha256: string;
    sourceDeliveryId: string;
  }): Promise<void> {
    await this.run(
      `
        INSERT INTO processed_prompt_activities (
          activity_id,
          agent_run_id,
          workspace_id,
          prompt_sha256,
          source_delivery_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id) DO NOTHING
      `,
      [
        input.activityId,
        input.agentRunId,
        input.workspaceId,
        input.promptSha256,
        input.sourceDeliveryId,
        nowIso()
      ]
    );
  }

  public async enqueueRunJob(payload: QueueJobPayload): Promise<string> {
    const timestamp = nowIso();
    const jobId = randomId("job");
    const inserted = await this.insertIgnore(
      "run_jobs",
      `
        INSERT INTO run_jobs (
          job_id,
          delivery_id,
          workspace_id,
          run_id,
          activity_id,
          event,
          payload_json,
          status,
          attempt_count,
          scheduled_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `,
      [
        jobId,
        payload.deliveryId,
        payload.workspaceId,
        payload.runId,
        payload.activityId,
        payload.event,
        JSON.stringify(payload),
        timestamp,
        timestamp,
        timestamp
      ]
    );

    if (!inserted) {
      const existing = await this.get<{ job_id: string }>("SELECT job_id FROM run_jobs WHERE delivery_id = ?", [
        payload.deliveryId
      ]);
      return existing?.job_id ?? jobId;
    }

    return jobId;
  }

  public async claimNextRunJob(workerId: string): Promise<RunJobRecord | null> {
    if (this.mode === "postgres") {
      const claimTime = nowIso();
      const claimed = await this.get<RowRecord>(
        `
          WITH next_job AS (
            SELECT job_id
            FROM run_jobs
            WHERE status IN ('pending', 'retry')
              AND scheduled_at <= ?
            ORDER BY scheduled_at ASC, created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE run_jobs
          SET status = 'running',
              attempt_count = attempt_count + 1,
              claimed_at = ?,
              heartbeat_at = ?,
              worker_id = ?,
              updated_at = ?
          WHERE job_id IN (SELECT job_id FROM next_job)
          RETURNING *
        `,
        [claimTime, claimTime, claimTime, workerId, claimTime]
      );

      return claimed ? mapJobRow(claimed) : null;
    }

    const row = await this.get<RowRecord>(
      `
        SELECT *
        FROM run_jobs
        WHERE status IN ('pending', 'retry')
          AND scheduled_at <= ?
        ORDER BY scheduled_at ASC, created_at ASC
        LIMIT 1
      `,
      [nowIso()]
    );

    if (!row) {
      return null;
    }

    const updatedAt = nowIso();
    const result = await this.run(
      `
        UPDATE run_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            claimed_at = ?,
            heartbeat_at = ?,
            worker_id = ?,
            updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'retry')
      `,
      [updatedAt, updatedAt, workerId, updatedAt, String(row.job_id)]
    );

    if (result.changes !== 1) {
      return null;
    }

    const claimed = await this.get<RowRecord>("SELECT * FROM run_jobs WHERE job_id = ?", [String(row.job_id)]);
    return claimed ? mapJobRow(claimed) : null;
  }

  public async recoverStaleRunningJobs(staleBeforeIso: string): Promise<number> {
    const result = await this.run(
      `
        UPDATE run_jobs
        SET status = 'retry',
            worker_id = NULL,
            claimed_at = NULL,
            updated_at = ?
        WHERE status = 'running'
          AND heartbeat_at IS NOT NULL
          AND heartbeat_at < ?
      `,
      [nowIso(), staleBeforeIso]
    );
    return result.changes;
  }

  public async heartbeatJob(jobId: string): Promise<void> {
    await this.run(
      "UPDATE run_jobs SET heartbeat_at = ?, updated_at = ? WHERE job_id = ?",
      [nowIso(), nowIso(), jobId]
    );
  }

  public async completeJob(jobId: string, status: RunJobRecord["status"]): Promise<void> {
    await this.run(
      "UPDATE run_jobs SET status = ?, completed_at = ?, updated_at = ? WHERE job_id = ?",
      [status, nowIso(), nowIso(), jobId]
    );
  }

  public async failJob(jobId: string, errorText: string, retryAt?: string | null): Promise<void> {
    const status = retryAt ? "retry" : "failed";
    await this.run(
      `
        UPDATE run_jobs
        SET status = ?,
            last_error = ?,
            scheduled_at = COALESCE(?, scheduled_at),
            updated_at = ?
        WHERE job_id = ?
      `,
      [status, errorText, retryAt ?? null, nowIso(), jobId]
    );
  }

  public async cancelRunJobs(runId: string): Promise<void> {
    await this.run(
      "UPDATE run_jobs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('pending', 'retry', 'running')",
      [nowIso(), nowIso(), runId]
    );
  }

  public async getRunState(runId: string): Promise<RunStateRecord | null> {
    const row = await this.get<RowRecord>("SELECT * FROM run_states WHERE run_id = ?", [runId]);
    if (!row) {
      return null;
    }

    return {
      runId: String(row.run_id),
      workspaceId: String(row.workspace_id),
      workspaceSlug: String(row.workspace_slug),
      specialist: row.specialist as RunStateRecord["specialist"],
      status: row.status as RunStateRecord["status"],
      writeCount: Number(row.write_count),
      lastPromptActivityId: row.last_prompt_activity_id ? String(row.last_prompt_activity_id) : null,
      summary: row.summary ? String(row.summary) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      workItemId: row.work_item_id ? String(row.work_item_id) : null,
      updatedAt: String(row.updated_at)
    };
  }

  public async upsertRunState(record: RunStateRecord): Promise<void> {
    await this.run(
      `
        INSERT INTO run_states (
          run_id,
          workspace_id,
          workspace_slug,
          specialist,
          status,
          write_count,
          last_prompt_activity_id,
          summary,
          project_id,
          work_item_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          workspace_slug = excluded.workspace_slug,
          specialist = excluded.specialist,
          status = excluded.status,
          write_count = excluded.write_count,
          last_prompt_activity_id = excluded.last_prompt_activity_id,
          summary = excluded.summary,
          project_id = excluded.project_id,
          work_item_id = excluded.work_item_id,
          updated_at = excluded.updated_at
      `,
      [
        record.runId,
        record.workspaceId,
        record.workspaceSlug,
        record.specialist,
        record.status,
        record.writeCount,
        record.lastPromptActivityId,
        record.summary,
        record.projectId,
        record.workItemId,
        record.updatedAt
      ]
    );
  }

  public async putRunMemory(record: RunMemoryRecord): Promise<void> {
    await this.run(
      `
        INSERT INTO run_memory (memory_key, workspace_id, project_id, object_id, summary, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_key) DO UPDATE SET
          summary = excluded.summary,
          updated_at = excluded.updated_at
      `,
      [
        record.memoryKey,
        record.workspaceId,
        record.projectId,
        record.objectId,
        record.summary,
        record.updatedAt
      ]
    );
  }

  public async getRunMemory(memoryKey: string): Promise<RunMemoryRecord | null> {
    const row = await this.get<RowRecord>("SELECT * FROM run_memory WHERE memory_key = ?", [memoryKey]);
    if (!row) {
      return null;
    }

    return {
      memoryKey: String(row.memory_key),
      workspaceId: String(row.workspace_id),
      projectId: row.project_id ? String(row.project_id) : null,
      objectId: row.object_id ? String(row.object_id) : null,
      summary: String(row.summary),
      updatedAt: String(row.updated_at)
    };
  }

  public async insertAuditLog(input: Omit<AuditLogRecord, "id" | "createdAt">): Promise<void> {
    await this.run(
      `
        INSERT INTO audit_logs (
          id,
          workspace_id,
          run_id,
          tool_name,
          policy_class,
          status,
          request_json,
          response_json,
          error_text,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomId("audit"),
        input.workspaceId,
        input.runId,
        input.toolName,
        input.policyClass,
        input.status,
        input.requestJson,
        input.responseJson,
        input.errorText,
        nowIso()
      ]
    );
  }

  public async beginToolExecution(input: {
    dedupeKey: string;
    workspaceId: string;
    runId: string;
    promptActivityId: string;
    toolName: string;
    requestJson: string;
  }): Promise<{ status: "new" | "started" | "succeeded"; responseJson: string | null }> {
    const timestamp = nowIso();
    const inserted = await this.insertIgnore(
      "tool_executions",
      `
        INSERT INTO tool_executions (
          dedupe_key,
          workspace_id,
          run_id,
          prompt_activity_id,
          tool_name,
          status,
          request_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?)
      `,
      [
        input.dedupeKey,
        input.workspaceId,
        input.runId,
        input.promptActivityId,
        input.toolName,
        input.requestJson,
        timestamp,
        timestamp
      ]
    );

    if (inserted) {
      return { status: "new", responseJson: null };
    }

    const existing = await this.get<{ status: string; response_json: string | null }>(
      "SELECT status, response_json FROM tool_executions WHERE dedupe_key = ?",
      [input.dedupeKey]
    );

    if (existing?.status === "failed") {
      await this.run(
        `
          UPDATE tool_executions
          SET status = 'started',
              request_json = ?,
              error_text = NULL,
              updated_at = ?
          WHERE dedupe_key = ?
        `,
        [input.requestJson, timestamp, input.dedupeKey]
      );
      return { status: "new", responseJson: null };
    }

    return {
      status: existing?.status === "started" ? "started" : "succeeded",
      responseJson: existing?.response_json ?? null
    };
  }

  public async completeToolExecution(dedupeKey: string, responseJson: string): Promise<void> {
    await this.run(
      `
        UPDATE tool_executions
        SET status = 'succeeded',
            response_json = ?,
            error_text = NULL,
            updated_at = ?
        WHERE dedupe_key = ?
      `,
      [responseJson, nowIso(), dedupeKey]
    );
  }

  public async failToolExecution(dedupeKey: string, errorText: string): Promise<void> {
    await this.run(
      `
        UPDATE tool_executions
        SET status = 'failed',
            error_text = ?,
            updated_at = ?
        WHERE dedupe_key = ?
      `,
      [errorText, nowIso(), dedupeKey]
    );
  }

  public async listRunJobs(limit = 50): Promise<RunJobRecord[]> {
    const rows = await this.all<RowRecord>(
      "SELECT * FROM run_jobs ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return rows.map(mapJobRow);
  }

  public async listAuditLogs(runId: string, limit = 50): Promise<AuditLogRecord[]> {
    const rows = await this.all<RowRecord>(
      "SELECT * FROM audit_logs WHERE run_id = ? ORDER BY created_at DESC LIMIT ?",
      [runId, limit]
    );
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      toolName: String(row.tool_name),
      policyClass: row.policy_class as AuditLogRecord["policyClass"],
      status: String(row.status),
      requestJson: String(row.request_json),
      responseJson: row.response_json ? String(row.response_json) : null,
      errorText: row.error_text ? String(row.error_text) : null,
      createdAt: String(row.created_at)
    }));
  }

  private mapInstallation(row: RowRecord): InstallationRecord {
    return {
      appInstallationId: String(row.app_installation_id),
      workspaceId: String(row.workspace_id),
      workspaceSlug: String(row.workspace_slug),
      botUserId: String(row.bot_user_id),
      botToken: String(row.bot_token),
      botTokenExpiresAt: String(row.bot_token_expires_at),
      scopes: String(row.scopes),
      status: String(row.status),
      installedAt: String(row.installed_at),
      updatedAt: String(row.updated_at),
      lastHealthcheckAt: row.last_healthcheck_at ? String(row.last_healthcheck_at) : null,
      lastHealthcheckError: row.last_healthcheck_error ? String(row.last_healthcheck_error) : null
    };
  }

  private async execMany(statements: string[]): Promise<void> {
    for (const statement of statements) {
      await this.run(statement);
    }
  }

  private ensureSqliteColumn(tableName: string, columnName: string, definition: string): void {
    if (!this.sqlite) {
      return;
    }

    const columns = this.sqlite
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;

    const hasColumn = columns.some((column) => column.name === columnName);
    if (hasColumn) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private rewriteParams(query: string): string {
    let index = 0;
    return query.replace(/\?/g, () => {
      index += 1;
      return `$${index}`;
    });
  }

  private async run(query: string, params: unknown[] = []): Promise<RunResult> {
    if (this.mode === "postgres") {
      const result = await this.pool!.query(this.rewriteParams(query), params);
      return { changes: result.rowCount ?? 0 };
    }

    const result = this.sqlite!.prepare(query).run(...params);
    return { changes: result.changes };
  }

  private async get<T>(query: string, params: unknown[] = []): Promise<T | undefined> {
    if (this.mode === "postgres") {
      const result = await this.pool!.query(this.rewriteParams(query), params);
      return result.rows[0] as T | undefined;
    }

    return this.sqlite!.prepare(query).get(...params) as T | undefined;
  }

  private async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    if (this.mode === "postgres") {
      const result = await this.pool!.query(this.rewriteParams(query), params);
      return result.rows as T[];
    }

    return this.sqlite!.prepare(query).all(...params) as T[];
  }

  private async insertIgnore(table: string, query: string, params: unknown[]): Promise<boolean> {
    if (this.mode === "postgres") {
      const pgQuery = `${query.trim().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
      const result = await this.pool!.query(this.rewriteParams(pgQuery), params);
      return (result.rowCount ?? 0) === 1;
    }

    const sqliteQuery = query.replace(`INSERT INTO ${table}`, `INSERT OR IGNORE INTO ${table}`);
    const result = this.sqlite!.prepare(sqliteQuery).run(...params);
    return result.changes === 1;
  }
}
