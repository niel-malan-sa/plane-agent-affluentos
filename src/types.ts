export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
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
  parameters?: Record<string, unknown>;
}

export interface AgentRunActivity {
  id: string;
  agent_run?: string;
  type: string;
  content: AgentRunActivityContent;
  content_metadata?: Record<string, unknown> | null;
  ephemeral?: boolean;
  signal?: string;
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
  type: "thought" | "action" | "response" | "error" | "elicitation";
  signal?: "continue" | "stop" | "auth_request" | "select";
  content: {
    type: string;
    body?: string;
    action?: string;
    parameters?: Record<string, unknown>;
  };
}
