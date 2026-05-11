export type AgentSignal = "continue" | "stop" | "auth_request" | "select";
export type ActivityType = "thought" | "action" | "response" | "elicitation" | "error";
export type SpecialistMode =
  | "triage"
  | "planner"
  | "execution"
  | "documentation"
  | "reviewer"
  | "coordination";
export type ToolPolicyClass = "read" | "write" | "delete" | "external" | "auth";
export type JobStatus =
  | "pending"
  | "running"
  | "processed"
  | "failed"
  | "ignored"
  | "cancelled"
  | "retry"
  | "stopped"
  | "waiting_for_input";

export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  refresh_token?: string;
}

export interface PlaneAppInstallation {
  id: string;
  workspace: string;
  workspace_detail: {
    id: string;
    name: string;
    slug: string;
    logo_url?: string | null;
  };
  app_bot: string;
  status: string;
  webhook?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface InstallationRecord {
  appInstallationId: string;
  workspaceId: string;
  workspaceSlug: string;
  botUserId: string;
  botToken: string;
  botTokenExpiresAt: string;
  scopes: string;
  status: string;
  installedAt: string;
  updatedAt: string;
  lastHealthcheckAt?: string | null;
  lastHealthcheckError?: string | null;
}

export interface UserTokenRecord {
  workspaceId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  scopes: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRecordInput {
  deliveryId: string;
  event: string;
  workspaceId: string | null;
  runId: string | null;
  activityId: string | null;
  payloadSha256: string;
}

export interface DeliveryReservationResult {
  accepted: boolean;
  existingStatus?: string;
}

export interface AgentRun {
  id: string;
  agent_user?: string;
  issue?: string;
  project?: string;
  workspace?: string;
  comment?: string;
  source_comment?: string;
  creator?: string;
  status?: string;
  started_at?: string;
  ended_at?: string | null;
  stopped_at?: string | null;
  external_link?: string | null;
  error_metadata?: unknown;
  type?: string;
}

export interface PaginatedResults<T> {
  next?: string | null;
  previous?: string | null;
  total_count?: number;
  total_pages?: number;
  count?: number;
  results: T[];
}

export interface AgentRunActivityContent {
  type: string;
  body?: string;
  action?: string;
  parameters?: Record<string, string>;
}

export interface AgentRunActivity {
  id: string;
  agent_run?: string;
  type: string;
  content: AgentRunActivityContent;
  content_metadata?: Record<string, unknown> | null;
  ephemeral?: boolean;
  signal?: AgentSignal;
  signal_metadata?: Record<string, unknown> | null;
  actor?: string;
  comment?: string | null;
  workspace?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AgentRunCreateWebhook {
  action: string;
  agent_run: AgentRun;
  agent_user_id?: string;
  app_client_id?: string;
  issue_id?: string;
  project_id?: string;
  workspace_id?: string;
  comment_id?: string;
  type?: string;
}

export interface AgentRunPromptWebhook {
  action: string;
  agent_run_activity: AgentRunActivity;
  agent_run: AgentRun;
  agent_user_id?: string;
  app_client_id?: string;
  comment_id?: string;
  issue_id?: string;
  project_id?: string;
  workspace_id?: string;
  type?: string;
}

export interface CreateActivityRequest {
  type: ActivityType;
  signal?: AgentSignal;
  signal_metadata?: Record<string, unknown>;
  content_metadata?: Record<string, unknown>;
  content: {
    type: ActivityType;
    body?: string;
    action?: string;
    parameters?: Record<string, string>;
  };
}

export interface PlaneProject {
  id: string;
  name: string;
  identifier?: string;
  description?: string | null;
}

export interface PlaneWorkItem {
  id: string;
  name: string;
  description_html?: string | null;
  priority?: string | null;
  state?: string | null;
  project_id?: string | null;
  assignees?: string[];
  labels?: string[];
  start_date?: string | null;
  target_date?: string | null;
  type?: string | null;
}

export interface PlanePage {
  id: string;
  name: string;
  description_html?: string | null;
}

export interface RunJobRecord {
  jobId: string;
  deliveryId: string;
  workspaceId: string;
  runId: string;
  activityId: string | null;
  event: string;
  payloadJson: string;
  status: JobStatus;
  attemptCount: number;
  scheduledAt: string;
  claimedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  workerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunStateRecord {
  runId: string;
  workspaceId: string;
  workspaceSlug: string;
  specialist: SpecialistMode;
  status: JobStatus;
  writeCount: number;
  lastPromptActivityId: string | null;
  summary: string | null;
  projectId: string | null;
  workItemId: string | null;
  updatedAt: string;
}

export interface RunMemoryRecord {
  memoryKey: string;
  workspaceId: string;
  projectId: string | null;
  objectId: string | null;
  summary: string;
  updatedAt: string;
}

export interface AuditLogRecord {
  id: string;
  workspaceId: string;
  runId: string;
  toolName: string;
  policyClass: ToolPolicyClass;
  status: string;
  requestJson: string;
  responseJson: string | null;
  errorText: string | null;
  createdAt: string;
}

export interface ToolContext {
  workspaceId: string;
  workspaceSlug: string;
  runId: string;
  promptActivityId: string;
  projectId?: string | null;
  workItemId?: string | null;
  actorUserId?: string | null;
  installation: InstallationRecord;
  specialist: SpecialistMode;
  dryRun: boolean;
  accessToken: string;
  authMode: "bot" | "user";
}

export interface ToolDefinition<TInput = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  scopes: string[];
  policyClass: ToolPolicyClass;
  timeoutMs: number;
  dryRunSupported: boolean;
  visibility: "public" | "redacted";
  inputSchema: {
    safeParse(input: unknown): { success: true; data: TInput } | { success: false; error: Error };
  };
  execute(context: ToolContext, input: TInput): Promise<TResult>;
  idempotencyKey?(context: ToolContext, input: TInput): string;
}

export interface ToolInvocation {
  toolName: string;
  input: Record<string, unknown>;
  purpose: string;
}

export interface PlannerDecision {
  specialist: SpecialistMode;
  thought: string;
  outcome: "respond" | "tool" | "elicitation" | "auth_request" | "select" | "error";
  responseBody?: string;
  authProvider?: "github" | "docs";
  elicitationBody?: string;
  selectionBody?: string;
  selectionOptions?: Array<{ id: string; label: string }>;
  toolCalls?: ToolInvocation[];
}

export interface RunContextEnvelope {
  run: AgentRun;
  activities: AgentRunActivity[];
  latestPromptBody: string;
  latestPromptActivityId: string;
  workspaceId: string;
  workspaceSlug: string;
  projectId?: string | null;
  workItemId?: string | null;
  memorySummary?: string | null;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface QueueJobPayload {
  deliveryId: string;
  event: string;
  workspaceId: string;
  runId: string;
  activityId: string | null;
  payload: Record<string, unknown>;
}
