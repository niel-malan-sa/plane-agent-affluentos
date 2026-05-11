import type { Logger } from "pino";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { OpenAIResponder } from "./openai-client.js";
import { PlaneApiClient } from "./plane-api.js";
import type {
  AgentRunActivity,
  InstallationRecord,
  PlannerDecision,
  PolicyDecision,
  QueueJobPayload,
  RunContextEnvelope,
  RunJobRecord,
  RunStateRecord,
  SpecialistMode,
  ToolContext,
  ToolDefinition,
  ToolInvocation
} from "./types.js";
import { clipText, nowIso, sha256Hex, toHtmlParagraphs } from "./utils.js";

const ReadProjectToolInput = z.object({});
const GetWorkItemInput = z.object({
  projectId: z.string().min(1),
  workItemId: z.string().min(1)
});
const ListWorkItemsInput = z.object({
  projectId: z.string().min(1)
});
const UpdateWorkItemInput = z.object({
  projectId: z.string().min(1),
  workItemId: z.string().min(1),
  patch: z.record(z.string(), z.unknown())
});
const CreateCommentInput = z.object({
  projectId: z.string().min(1),
  workItemId: z.string().min(1),
  body: z.string().min(1)
});
const CreateWorkItemInput = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  priority: z.string().optional()
});
const CreateProjectPageInput = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  body: z.string().min(1)
});
const CreateWikiPageInput = z.object({
  name: z.string().min(1),
  body: z.string().min(1)
});
const CreateLinkInput = z.object({
  projectId: z.string().min(1),
  workItemId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1).optional()
});

function inputSchema<T extends z.ZodTypeAny>(
  schema: T
): ToolDefinition<z.infer<T>>["inputSchema"] {
  return {
    safeParse(value: unknown) {
      const result = schema.safeParse(value);
      return result.success
        ? { success: true, data: result.data }
        : { success: false, error: result.error };
    }
  };
}

export function buildScopeMatrix(): Array<{
  family: string;
  scopes: string[];
  tools: string[];
  tokenMode: "bot" | "user" | "both";
}> {
  return [
    {
      family: "agent-runs",
      scopes: ["agents.runs:read", "agents.run_activities:read", "agents.run_activities:write"],
      tools: ["plane.run_context", "plane.respond"],
      tokenMode: "bot"
    },
    {
      family: "projects-and-work-items",
      scopes: [
        "projects:read",
        "projects.work_items:read",
        "projects.work_items:write",
        "projects.work_items.comments:read",
        "projects.work_items.comments:write",
        "projects.work_items.links:read",
        "projects.work_items.links:write"
      ],
      tools: [
        "plane.list_projects",
        "plane.get_work_item",
        "plane.list_work_items",
        "plane.create_work_item",
        "plane.update_work_item",
        "plane.create_comment",
        "plane.create_link"
      ],
      tokenMode: "both"
    },
    {
      family: "documentation",
      scopes: ["projects.pages:write", "wiki.pages:write"],
      tools: ["plane.create_project_page", "plane.create_wiki_page"],
      tokenMode: "both"
    },
    {
      family: "workspace-read",
      scopes: ["profile:read", "workspaces.members:read", "teamspaces:read", "assets:read"],
      tools: [],
      tokenMode: "user"
    }
  ];
}

export class PolicyEngine {
  public constructor(private readonly config: AppConfig) {}

  public decide(
    tool: ToolDefinition,
    context: ToolContext,
    writeCount: number
  ): PolicyDecision {
    if (tool.policyClass === "delete") {
      return { allowed: false, reason: "Destructive delete operations are blocked by default." };
    }

    if (tool.policyClass === "write") {
      if (this.config.WRITE_KILL_SWITCH) {
        return { allowed: false, reason: "Write kill switch is enabled." };
      }

      if (!this.config.ENABLE_AUTONOMOUS_WRITES) {
        return { allowed: false, reason: "Autonomous writes are disabled in config." };
      }

      if (writeCount >= this.config.MAX_WRITES_PER_RUN) {
        return { allowed: false, reason: "Maximum writes per run reached." };
      }
    }

    if (context.projectId && this.config.projectBlocklist.has(context.projectId)) {
      return { allowed: false, reason: "Project is explicitly blocked for autonomous actions." };
    }

    if (
      context.projectId &&
      this.config.projectAllowlist.size > 0 &&
      !this.config.projectAllowlist.has(context.projectId)
    ) {
      return { allowed: false, reason: "Project is not in the configured allowlist." };
    }

    return { allowed: true, reason: "Allowed by current policy." };
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public constructor(private readonly planeApi: PlaneApiClient) {
    this.registerTool({
      name: "plane.list_projects",
      description: "List Plane projects in the workspace.",
      scopes: ["projects:read"],
      policyClass: "read",
      timeoutMs: 20000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(ReadProjectToolInput),
      execute: async (context) => this.planeApi.listProjects(context.workspaceSlug, context.accessToken)
    });
    this.registerTool({
      name: "plane.get_work_item",
      description: "Retrieve one Plane work item.",
      scopes: ["projects.work_items:read"],
      policyClass: "read",
      timeoutMs: 20000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(GetWorkItemInput),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof GetWorkItemInput>;
        return this.planeApi.getWorkItem(
          context.workspaceSlug,
          input.projectId,
          input.workItemId,
          context.accessToken
        );
      }
    });
    this.registerTool({
      name: "plane.list_work_items",
      description: "List work items in a project.",
      scopes: ["projects.work_items:read"],
      policyClass: "read",
      timeoutMs: 20000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(ListWorkItemsInput),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof ListWorkItemsInput>;
        return this.planeApi.listWorkItems(context.workspaceSlug, input.projectId, context.accessToken);
      }
    });
    this.registerTool({
      name: "plane.create_work_item",
      description: "Create a Plane work item in a project.",
      scopes: ["projects.work_items:write"],
      policyClass: "write",
      timeoutMs: 25000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(CreateWorkItemInput),
      idempotencyKey: (context, input) =>
        sha256Hex(`${context.runId}:${context.promptActivityId}:plane.create_work_item:${JSON.stringify(input)}`),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof CreateWorkItemInput>;
        if (context.dryRun) {
          return { dryRun: true, wouldCreate: input };
        }
        return this.planeApi.createWorkItem(context.workspaceSlug, input.projectId, context.accessToken, {
          name: input.name,
          description_html: input.description ? toHtmlParagraphs(input.description) : undefined,
          priority: input.priority
        });
      }
    });
    this.registerTool({
      name: "plane.update_work_item",
      description: "Patch a Plane work item.",
      scopes: ["projects.work_items:write"],
      policyClass: "write",
      timeoutMs: 25000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(UpdateWorkItemInput),
      idempotencyKey: (context, input) =>
        sha256Hex(`${context.runId}:${context.promptActivityId}:plane.update_work_item:${JSON.stringify(input)}`),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof UpdateWorkItemInput>;
        if (context.dryRun) {
          return { dryRun: true, wouldPatch: input.patch };
        }
        return this.planeApi.updateWorkItem(
          context.workspaceSlug,
          input.projectId,
          input.workItemId,
          context.accessToken,
          input.patch
        );
      }
    });
    this.registerTool({
      name: "plane.create_comment",
      description: "Post a Plane work item comment.",
      scopes: ["projects.work_items.comments:write"],
      policyClass: "write",
      timeoutMs: 25000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(CreateCommentInput),
      idempotencyKey: (context, input) =>
        sha256Hex(`${context.runId}:${context.promptActivityId}:plane.create_comment:${JSON.stringify(input)}`),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof CreateCommentInput>;
        if (context.dryRun) {
          return { dryRun: true, wouldComment: input.body };
        }
        return this.planeApi.createComment(
          context.workspaceSlug,
          input.projectId,
          input.workItemId,
          context.accessToken,
          {
            comment_html: toHtmlParagraphs(input.body),
            access: "INTERNAL"
          }
        );
      }
    });
    this.registerTool({
      name: "plane.create_project_page",
      description: "Create a project page in Plane.",
      scopes: ["projects.pages:write"],
      policyClass: "write",
      timeoutMs: 25000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(CreateProjectPageInput),
      idempotencyKey: (context, input) =>
        sha256Hex(`${context.runId}:${context.promptActivityId}:plane.create_project_page:${JSON.stringify(input)}`),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof CreateProjectPageInput>;
        if (context.dryRun) {
          return { dryRun: true, wouldCreatePage: input.name };
        }
        return this.planeApi.createProjectPage(
          context.workspaceSlug,
          input.projectId,
          context.accessToken,
          {
            name: input.name,
            description_html: toHtmlParagraphs(input.body)
          }
        );
      }
    });
    this.registerTool({
      name: "plane.create_wiki_page",
      description: "Create a workspace wiki page in Plane.",
      scopes: ["wiki.pages:write"],
      policyClass: "write",
      timeoutMs: 25000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(CreateWikiPageInput),
      idempotencyKey: (context, input) =>
        sha256Hex(`${context.runId}:${context.promptActivityId}:plane.create_wiki_page:${JSON.stringify(input)}`),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof CreateWikiPageInput>;
        if (context.dryRun) {
          return { dryRun: true, wouldCreateWikiPage: input.name };
        }
        return this.planeApi.createWikiPage(context.workspaceSlug, context.accessToken, {
          name: input.name,
          description_html: toHtmlParagraphs(input.body)
        });
      }
    });
    this.registerTool({
      name: "plane.create_link",
      description: "Create an external link on a Plane work item.",
      scopes: ["projects.work_items.links:write"],
      policyClass: "write",
      timeoutMs: 20000,
      dryRunSupported: true,
      visibility: "public",
      inputSchema: inputSchema(CreateLinkInput),
      idempotencyKey: (context, input) =>
        sha256Hex(`${context.runId}:${context.promptActivityId}:plane.create_link:${JSON.stringify(input)}`),
      execute: async (context, rawInput) => {
        const input = rawInput as z.infer<typeof CreateLinkInput>;
        if (context.dryRun) {
          return { dryRun: true, wouldCreateLink: input.url };
        }
        return this.planeApi.createLink(
          context.workspaceSlug,
          input.projectId,
          input.workItemId,
          context.accessToken,
          {
            title: input.title ?? input.url,
            url: input.url
          }
        );
      }
    });
  }

  public listCatalog(): Array<{ name: string; description: string; scopes: string[]; policyClass: string }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      scopes: tool.scopes,
      policyClass: tool.policyClass
    }));
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  private registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }
}

export function extractLatestPrompt(
  activities: AgentRunActivity[],
  botUserId: string
): AgentRunActivity | null {
  const prompts = activities.filter((activity) => {
    return activity.type === "prompt" && typeof activity.content?.body === "string" && activity.actor !== botUserId;
  });

  prompts.sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
    return leftTime - rightTime;
  });

  return prompts.at(-1) ?? null;
}

function chooseSpecialist(promptBody: string): SpecialistMode {
  const value = promptBody.toLowerCase();
  if (/\b(plan|roadmap|break down|sequence)\b/.test(value)) return "planner";
  if (/\b(risk|review|concern|safety)\b/.test(value)) return "reviewer";
  if (/\b(doc|wiki|write up|documentation)\b/.test(value)) return "documentation";
  if (/\b(triage|classify|categorize)\b/.test(value)) return "triage";
  if (/\b(coord|handoff|follow up|notify)\b/.test(value)) return "coordination";
  return "execution";
}

export class RunWorker {
  private readonly toolRegistry: ToolRegistry;
  private readonly policyEngine: PolicyEngine;
  private stopped = false;
  private interval?: NodeJS.Timeout;
  private readonly workerId = `worker-${process.pid}`;
  private activeJobs = 0;

  public constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly planeApi: PlaneApiClient,
    private readonly model: OpenAIResponder | null,
    private readonly logger: Logger
  ) {
    this.toolRegistry = new ToolRegistry(planeApi);
    this.policyEngine = new PolicyEngine(config);
  }

  public getScopeMatrix() {
    return buildScopeMatrix();
  }

  public start(): void {
    this.interval = setInterval(() => {
      void this.pump();
    }, this.config.WORKER_POLL_INTERVAL_MS);
    void this.pump();
  }

  public stop(): void {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  public async waitForIdle(): Promise<void> {
    while (this.activeJobs > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  public async tick(): Promise<void> {
    await this.pump();
  }

  private async pump(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const recovered = await this.db.recoverStaleRunningJobs(
      new Date(Date.now() - this.config.RUN_STALE_AFTER_MS).toISOString()
    );
    if (recovered > 0) {
      this.logger.warn({ recovered }, "Recovered stale running Plane agent jobs");
    }

    while (!this.stopped && this.activeJobs < this.config.WORKER_CONCURRENCY) {
      const job = await this.db.claimNextRunJob(this.workerId);
      if (!job) {
        break;
      }

      this.activeJobs += 1;
      void this.processClaimedJob(job).finally(() => {
        this.activeJobs -= 1;
      });
    }
  }

  private async processClaimedJob(job: RunJobRecord): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.db.heartbeatJob(job.jobId);
    }, this.config.RUN_HEARTBEAT_INTERVAL_MS);

    try {
      await this.processJob(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker failure";
      this.logger.error({ err: error, jobId: job.jobId }, "Run worker job failed");
      await this.reportJobFailure(job, message);
      await this.db.failJob(job.jobId, message);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async processJob(job: RunJobRecord): Promise<void> {
    const payload = JSON.parse(job.payloadJson) as QueueJobPayload;
    const installation = await this.planeApi.getInstallationForWorkspace(payload.workspaceId);
    if (!installation) {
      await this.db.markDeliveryStatus(payload.deliveryId, "missing_installation", "No installation found");
      await this.db.completeJob(job.jobId, "ignored");
      return;
    }

    const run = await this.planeApi.getRun(installation.workspaceSlug, payload.runId, installation.botToken);
    const activities = await this.planeApi.listActivities(
      installation.workspaceSlug,
      payload.runId,
      installation.botToken
    );

    const promptActivity =
      payload.activityId && payload.event === "agent_run_user_prompt"
        ? activities.find((activity) => activity.id === payload.activityId) ?? extractLatestPrompt(activities, installation.botUserId)
        : extractLatestPrompt(activities, installation.botUserId);

    if (!promptActivity) {
      await this.db.markDeliveryStatus(payload.deliveryId, "waiting_for_prompt");
      await this.db.completeJob(job.jobId, "waiting_for_input");
      return;
    }

    if (await this.db.isPromptProcessed(promptActivity.id)) {
      await this.db.markDeliveryStatus(payload.deliveryId, "duplicate_prompt");
      await this.db.completeJob(job.jobId, "ignored");
      return;
    }

    if (promptActivity.signal === "stop" || ["stopping", "stopped"].includes((run.status ?? "").toLowerCase())) {
      await this.db.cancelRunJobs(run.id);
      await this.planeApi.createActivity(installation.workspaceSlug, run.id, installation.botToken, {
        type: "response",
        content: {
          type: "response",
          body: "Stopped. No further actions will be taken for this run."
        }
      });
      await this.db.markPromptProcessed({
        activityId: promptActivity.id,
        agentRunId: run.id,
        workspaceId: payload.workspaceId,
        promptSha256: sha256Hex(promptActivity.content.body ?? ""),
        sourceDeliveryId: payload.deliveryId
      });
      await this.db.markDeliveryStatus(payload.deliveryId, "stopped");
      await this.db.completeJob(job.jobId, "stopped");
      return;
    }

    const memoryKey = `${payload.workspaceId}:${run.project ?? "workspace"}:${run.issue ?? run.id}`;
    const memory = await this.db.getRunMemory(memoryKey);
    const context: RunContextEnvelope = {
      run,
      activities,
      latestPromptBody: promptActivity.content.body ?? "",
      latestPromptActivityId: promptActivity.id,
      workspaceId: payload.workspaceId,
      workspaceSlug: installation.workspaceSlug,
      projectId: run.project ?? null,
      workItemId: run.issue ?? null,
      memorySummary: memory?.summary ?? null
    };

    const baseSpecialist = chooseSpecialist(context.latestPromptBody);
    const state: RunStateRecord = {
      runId: run.id,
      workspaceId: payload.workspaceId,
      workspaceSlug: installation.workspaceSlug,
      specialist: baseSpecialist,
      status: "running",
      writeCount: (await this.db.getRunState(run.id))?.writeCount ?? 0,
      lastPromptActivityId: promptActivity.id,
      summary: memory?.summary ?? null,
      projectId: context.projectId ?? null,
      workItemId: context.workItemId ?? null,
      updatedAt: nowIso()
    };
    await this.db.upsertRunState(state);

    const decision = await this.makeDecision(context);
    await this.planeApi.createActivity(installation.workspaceSlug, run.id, installation.botToken, {
      type: "thought",
      content: {
        type: "thought",
        body: decision.thought
      }
    });

    const toolResults =
      decision.outcome === "tool" ? await this.executeTools(decision, context, installation, state, job.jobId) : [];
    const outcome = await this.emitOutcome(decision, context, installation, toolResults);

    await this.db.markPromptProcessed({
      activityId: promptActivity.id,
      agentRunId: run.id,
      workspaceId: payload.workspaceId,
      promptSha256: sha256Hex(promptActivity.content.body ?? ""),
      sourceDeliveryId: payload.deliveryId
    });
    await this.db.markDeliveryStatus(payload.deliveryId, outcome.status);
    await this.db.completeJob(job.jobId, outcome.status as RunJobRecord["status"]);

    if (outcome.status === "processed" && outcome.responseBody && this.model) {
      const summary = await this.model.summarizeMemory(context, outcome.responseBody);
      await this.db.putRunMemory({
        memoryKey,
        workspaceId: payload.workspaceId,
        projectId: context.projectId ?? null,
        objectId: context.workItemId ?? run.id,
        summary,
        updatedAt: nowIso()
      });
      await this.db.upsertRunState({
        ...state,
        specialist: decision.specialist,
        status: "processed",
        summary,
        updatedAt: nowIso()
      });
    }
  }

  private async makeDecision(context: RunContextEnvelope): Promise<PlannerDecision> {
    if (!this.model) {
      return {
        specialist: chooseSpecialist(context.latestPromptBody),
        thought: "This process does not have the model runtime enabled.",
        outcome: "error",
        responseBody: "This process is not configured to execute Plane runs."
      };
    }

    if (!context.projectId && /\b(project|which project)\b/i.test(context.latestPromptBody)) {
      return {
        specialist: "triage",
        thought: "The prompt references project work without a resolved project target.",
        outcome: "elicitation",
        elicitationBody: "I need the target Plane project before I can act. Reply with the project name or project ID."
      };
    }

    if (/\bgithub\b/i.test(context.latestPromptBody) && this.config.EXTERNAL_AUTH_GITHUB_URL) {
      return {
        specialist: chooseSpecialist(context.latestPromptBody),
        thought: "The request references GitHub and may require external authorization.",
        outcome: "auth_request",
        authProvider: "github",
        elicitationBody: "I need GitHub authorization before I can use connected repository actions for this run."
      };
    }

    try {
      const decision = await this.model.planRun({
        context,
        toolCatalog: this.toolRegistry.listCatalog()
      });
      return {
        ...decision,
        specialist: decision.specialist || chooseSpecialist(context.latestPromptBody)
      };
    } catch {
      return {
        specialist: chooseSpecialist(context.latestPromptBody),
        thought: "Falling back to a direct response because structured planning did not parse cleanly.",
        outcome: "respond",
        responseBody:
          "I reviewed the current Plane run context. I can continue once you specify the exact project or work item action you want."
      };
    }
  }

  private async executeTools(
    decision: PlannerDecision,
    context: RunContextEnvelope,
    installation: InstallationRecord,
    state: RunStateRecord,
    jobId: string
  ): Promise<Array<{ invocation: ToolInvocation; result: unknown }>> {
    const results: Array<{ invocation: ToolInvocation; result: unknown }> = [];
    let writeCount = state.writeCount;

    for (const invocation of decision.toolCalls?.slice(0, this.config.OPENAI_MAX_TOOL_STEPS) ?? []) {
      const tool = this.toolRegistry.get(invocation.toolName);
      if (!tool) {
        throw new Error(`Unknown tool ${invocation.toolName}`);
      }

      const parsed = tool.inputSchema.safeParse(invocation.input);
      if (!parsed.success) {
        throw parsed.error;
      }

      const targetProjectId =
        typeof invocation.input.projectId === "string" ? invocation.input.projectId : context.projectId;
      const targetWorkItemId =
        typeof invocation.input.workItemId === "string" ? invocation.input.workItemId : context.workItemId;
      const userToken =
        context.run.creator && tool.policyClass !== "read"
          ? await this.planeApi.getUserTokenForWorkspaceUser(context.workspaceId, context.run.creator)
          : null;
      const accessToken = userToken?.accessToken ?? installation.botToken;

      const toolContext: ToolContext = {
        workspaceId: context.workspaceId,
        workspaceSlug: context.workspaceSlug,
        runId: context.run.id,
        promptActivityId: context.latestPromptActivityId,
        projectId: targetProjectId,
        workItemId: targetWorkItemId,
        installation,
        actorUserId: context.run.creator ?? null,
        specialist: decision.specialist,
        dryRun: tool.policyClass === "write" && !this.config.ENABLE_AUTONOMOUS_WRITES,
        accessToken,
        authMode: userToken ? "user" : "bot"
      };
      const policy = this.policyEngine.decide(tool, toolContext, writeCount);
      if (!policy.allowed) {
        await this.db.insertAuditLog({
          workspaceId: context.workspaceId,
          runId: context.run.id,
          toolName: tool.name,
          policyClass: tool.policyClass,
          status: "blocked",
          requestJson: JSON.stringify(invocation.input),
          responseJson: null,
          errorText: policy.reason
        });
        results.push({
          invocation,
          result: { blocked: true, reason: policy.reason }
        });
        continue;
      }

      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "action",
        content: {
          type: "action",
          action: tool.name,
          parameters: Object.fromEntries(
            Object.entries(invocation.input).map(([key, value]) => [key, clipText(String(value), 200)])
          )
        }
      });

      const dedupeKey =
        tool.policyClass === "write" && tool.idempotencyKey
          ? tool.idempotencyKey(toolContext, parsed.data)
          : null;
      if (dedupeKey) {
        const claim = await this.db.beginToolExecution({
          dedupeKey,
          workspaceId: context.workspaceId,
          runId: context.run.id,
          promptActivityId: context.latestPromptActivityId,
          toolName: tool.name,
          requestJson: JSON.stringify(invocation.input)
        });

        if (claim.status === "succeeded" && claim.responseJson) {
          const cachedResult = JSON.parse(claim.responseJson) as unknown;
          results.push({ invocation, result: { replayed: true, cached: true, result: cachedResult } });
          continue;
        }

        if (claim.status === "started") {
          results.push({
            invocation,
            result: {
              blocked: true,
              reason: "A prior execution for this mutation is already in progress or awaiting reconciliation."
            }
          });
          continue;
        }
      }

      let result: unknown;
      try {
        result = await tool.execute(toolContext, parsed.data);
      } catch (error) {
        if (dedupeKey) {
          await this.db.failToolExecution(
            dedupeKey,
            error instanceof Error ? error.message : "Unknown tool execution failure"
          );
        }
        throw error;
      }

      if (dedupeKey) {
        await this.db.completeToolExecution(dedupeKey, JSON.stringify(result));
      }

      await this.db.insertAuditLog({
        workspaceId: context.workspaceId,
        runId: context.run.id,
        toolName: tool.name,
        policyClass: tool.policyClass,
        status: "ok",
        requestJson: JSON.stringify(invocation.input),
        responseJson: JSON.stringify(result),
        errorText: null
      });
      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "action",
        content: {
          type: "action",
          action: tool.name,
          parameters: {
            result: clipText(JSON.stringify(result), 280)
          }
        },
        content_metadata: { result }
      });
      results.push({ invocation, result });

      if (tool.policyClass === "write" && !toolContext.dryRun) {
        writeCount += 1;
      }

      await this.db.upsertRunState({
        ...state,
        specialist: decision.specialist,
        writeCount,
        updatedAt: nowIso()
      });
      await this.db.heartbeatJob(jobId);
    }

    return results;
  }

  private async emitOutcome(
    decision: PlannerDecision,
    context: RunContextEnvelope,
    installation: InstallationRecord,
    toolResults: Array<{ invocation: ToolInvocation; result: unknown }>
  ): Promise<{ status: string; responseBody?: string }> {
    if (decision.outcome === "respond") {
      const responseBody =
        decision.responseBody ?? "I reviewed the run context and I am ready for the next instruction.";
      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "response",
        signal: "continue",
        content: {
          type: "response",
          body: responseBody
        }
      });
      return { status: "processed", responseBody };
    }

    if (decision.outcome === "tool") {
      if (!this.model) {
        return {
          status: "failed",
          responseBody: "This process is not configured to execute Plane runs."
        };
      }
      const finalResponse = await this.model.writeFinalResponse({
        specialist: decision.specialist,
        context,
        toolResults
      });
      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "response",
        signal: "continue",
        content: {
          type: "response",
          body: finalResponse
        }
      });
      return { status: "processed", responseBody: finalResponse };
    }

    if (decision.outcome === "elicitation") {
      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "elicitation",
        content: {
          type: "elicitation",
          body: decision.elicitationBody ?? "I need one more detail before I continue."
        }
      });
      return { status: "waiting_for_input" };
    }

    if (decision.outcome === "select") {
      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "elicitation",
        signal: "select",
        signal_metadata: {
          options: decision.selectionOptions ?? []
        },
        content: {
          type: "elicitation",
          body: decision.selectionBody ?? "Choose one of the options below."
        }
      });
      return { status: "waiting_for_input" };
    }

    if (decision.outcome === "auth_request") {
      const url =
        decision.authProvider === "github"
          ? this.config.EXTERNAL_AUTH_GITHUB_URL
          : this.config.EXTERNAL_AUTH_DOCS_URL;
      if (!url) {
        const body =
          "This run needs external authorization, but no external auth URL is configured for that provider.";
        await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
          type: "error",
          content: {
            type: "error",
            body
          }
        });
        return { status: "failed", responseBody: body };
      }
      const handoffUrl = `${this.config.PUBLIC_BASE_URL}/auth/external/${decision.authProvider ?? "docs"}?runId=${encodeURIComponent(context.run.id)}&workspaceId=${encodeURIComponent(context.workspaceId)}`;
      await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
        type: "elicitation",
        signal: "auth_request",
        signal_metadata: {
          url: handoffUrl
        },
        content: {
          type: "elicitation",
          body:
            decision.elicitationBody ??
            "Authentication is required before I can continue with the connected external action."
        }
      });
      return { status: "waiting_for_input" };
    }

    const errorBody =
      decision.responseBody ?? "I could not complete the request because the agent runtime hit an error.";
    await this.planeApi.createActivity(context.workspaceSlug, context.run.id, installation.botToken, {
      type: "error",
      content: {
        type: "error",
        body: errorBody
      }
    });
    return { status: "failed", responseBody: errorBody };
  }

  private async reportJobFailure(job: RunJobRecord, message: string): Promise<void> {
    try {
      const payload = JSON.parse(job.payloadJson) as QueueJobPayload;
      await this.db.markDeliveryStatus(payload.deliveryId, "failed", message);

      const installation = await this.planeApi.getInstallationForWorkspace(payload.workspaceId);
      if (!installation) {
        return;
      }

      await this.planeApi.createActivity(installation.workspaceSlug, payload.runId, installation.botToken, {
        type: "error",
        content: {
          type: "error",
          body: `Run failed: ${clipText(message, 400)}`
        }
      });

      const priorState = await this.db.getRunState(payload.runId);
      if (priorState) {
        await this.db.upsertRunState({
          ...priorState,
          status: "failed",
          updatedAt: nowIso()
        });
      }
    } catch (error) {
      this.logger.error({ err: error, jobId: job.jobId }, "Failed to report Plane worker failure");
    }
  }
}
