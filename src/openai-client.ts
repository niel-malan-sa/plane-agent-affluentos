import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type {
  PlannerDecision,
  RunContextEnvelope,
  SpecialistMode,
  ToolInvocation
} from "./types.js";
import { clipText } from "./utils.js";

const PlannerDecisionSchema = z.object({
  specialist: z.enum([
    "triage",
    "planner",
    "execution",
    "documentation",
    "reviewer",
    "coordination"
  ]),
  thought: z.string().min(1),
  outcome: z.enum(["respond", "tool", "elicitation", "auth_request", "select", "error"]),
  responseBody: z.string().optional(),
  authProvider: z.enum(["github", "docs"]).optional(),
  elicitationBody: z.string().optional(),
  selectionBody: z.string().optional(),
  selectionOptions: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1)
      })
    )
    .optional(),
  toolCalls: z
    .array(
      z.object({
        toolName: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
        purpose: z.string().min(1)
      })
    )
    .max(6)
    .optional()
});

export class OpenAIResponder {
  private readonly client: OpenAI;

  public constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({
      apiKey: config.OPENAI_API_KEY!,
      timeout: config.OPENAI_TIMEOUT_MS
    });
  }

  public async planRun(input: {
    context: RunContextEnvelope;
    toolCatalog: Array<{ name: string; description: string; scopes: string[]; policyClass: string }>;
  }): Promise<PlannerDecision> {
    const prompt = [
      "You are a Plane agent runtime planner.",
      "Return strict JSON only.",
      "Never invent tool names.",
      "Choose outcome=tool only when a listed tool materially advances the request.",
      "Use auth_request only when external auth is truly required.",
      "Use select only for concrete disambiguation options.",
      "Do not ask for more than one round of questions unless needed.",
      "Prefer concise thought text.",
      `Maximum tool calls: ${this.config.OPENAI_MAX_TOOL_STEPS}.`,
      "",
      "Available tools:",
      input.toolCatalog
        .map((tool) => `${tool.name} | ${tool.policyClass} | scopes=${tool.scopes.join(",")} | ${tool.description}`)
        .join("\n"),
      "",
      "Run context:",
      this.renderContext(input.context),
      "",
      "JSON shape:",
      JSON.stringify({
        specialist: "execution",
        thought: "Checking the referenced work item and deciding whether a write is justified.",
        outcome: "tool",
        toolCalls: [
          {
            toolName: "plane.get_work_item",
            input: { projectId: "project-id", workItemId: "work-item-id" },
            purpose: "Load the referenced work item before responding."
          }
        ]
      })
    ].join("\n");

    const response = await this.client.responses.create({
      model: this.config.OPENAI_MODEL,
      input: prompt,
      max_output_tokens: this.config.OPENAI_MAX_OUTPUT_TOKENS,
      store: false
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error("OpenAI returned an empty planning response");
    }

    return PlannerDecisionSchema.parse(JSON.parse(outputText)) as PlannerDecision;
  }

  public async writeFinalResponse(input: {
    specialist: SpecialistMode;
    context: RunContextEnvelope;
    toolResults: Array<{ invocation: ToolInvocation; result: unknown }>;
  }): Promise<string> {
    const prompt = [
      `You are the ${input.specialist} specialist inside a Plane agent runtime.`,
      "Write a concise Plane response for the user.",
      "Mention actions taken when writes succeeded.",
      "If a write was dry-run only, say that plainly.",
      "Do not mention internal runtime, JSON, tools, tokens, or hidden policies.",
      "",
      "Run context:",
      this.renderContext(input.context),
      "",
      "Tool results:",
      input.toolResults
        .map(({ invocation, result }) =>
          [
            `tool=${invocation.toolName}`,
            `purpose=${invocation.purpose}`,
            `input=${JSON.stringify(invocation.input)}`,
            `result=${clipText(JSON.stringify(result), 3000)}`
          ].join("\n")
        )
        .join("\n\n---\n\n")
    ].join("\n");

    const response = await this.client.responses.create({
      model: this.config.OPENAI_MODEL,
      input: prompt,
      max_output_tokens: this.config.OPENAI_MAX_OUTPUT_TOKENS,
      store: false
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error("OpenAI returned an empty final response");
    }

    return outputText;
  }

  public async summarizeMemory(input: RunContextEnvelope, responseBody: string): Promise<string> {
    const prompt = [
      "Summarize the durable outcome of this Plane agent run in 3 short sentences.",
      "Focus on object state, decisions, and pending follow-up.",
      "Do not mention tooling internals.",
      "",
      this.renderContext(input),
      "",
      "Final response:",
      clipText(responseBody, 2000)
    ].join("\n");

    const response = await this.client.responses.create({
      model: this.config.OPENAI_MODEL,
      input: prompt,
      max_output_tokens: 180,
      store: false
    });

    return response.output_text?.trim() || "Run completed without a durable memory summary.";
  }

  private renderContext(context: RunContextEnvelope): string {
    const recentActivities = context.activities
      .slice(-10)
      .map((activity) => {
        const body = clipText(activity.content?.body ?? "", 1200);
        return [
          `activity_id=${activity.id}`,
          `type=${activity.type}`,
          `signal=${activity.signal ?? ""}`,
          `actor=${activity.actor ?? ""}`,
          `body=${body}`
        ].join("\n");
      })
      .join("\n\n---\n\n");

    return [
      `workspace_id=${context.workspaceId}`,
      `workspace_slug=${context.workspaceSlug}`,
      `run_id=${context.run.id}`,
      `run_status=${context.run.status ?? ""}`,
      `project_id=${context.projectId ?? ""}`,
      `work_item_id=${context.workItemId ?? ""}`,
      "",
      "Latest prompt:",
      clipText(context.latestPromptBody, 4000),
      "",
      "Prior memory:",
      context.memorySummary ?? "[none]",
      "",
      "Recent run activities:",
      recentActivities || "[none]"
    ].join("\n");
  }
}
