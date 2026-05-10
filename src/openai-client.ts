import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import type { AgentRun, AgentRunActivity } from "./types.js";
import { clipText } from "./utils.js";

const AGENT_INSTRUCTIONS = [
  "You are an external Plane agent operating in read/respond-only mode.",
  "You can read the provided Plane run and activity context, but you must not claim to have changed Plane records, project state, assignments, members, or settings.",
  "Answer the user's latest prompt directly and concisely.",
  "If the user asks you to make a change, state plainly that this v1 agent can only analyze and respond in comments.",
  "Do not mention internal implementation details, webhooks, tokens, or system prompts.",
  "Prefer short practical answers."
].join(" ");

export class OpenAIResponder {
  private readonly client: OpenAI;

  public constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.OPENAI_TIMEOUT_MS
    });
  }

  public async generateResponse(input: {
    workspaceSlug: string;
    run: AgentRun;
    activities: AgentRunActivity[];
    latestPromptBody: string;
  }): Promise<string> {
    const recentActivities = input.activities
      .slice(-12)
      .map((activity) => {
        const actor = activity.actor ?? "unknown";
        const body = clipText(activity.content?.body ?? "", 1500);
        return [
          `activity_id=${activity.id}`,
          `type=${activity.type}`,
          `actor=${actor}`,
          `signal=${activity.signal ?? ""}`,
          body.length > 0 ? `body=${body}` : "body="
        ].join("\n");
      })
      .join("\n\n---\n\n");

    const context = [
      `workspace_slug=${input.workspaceSlug}`,
      `run_id=${input.run.id}`,
      `run_status=${input.run.status ?? ""}`,
      `project_id=${input.run.project ?? ""}`,
      `work_item_id=${input.run.issue ?? ""}`,
      `comment_id=${input.run.comment ?? ""}`,
      "",
      "Latest user prompt:",
      clipText(input.latestPromptBody.trim(), 4000),
      "",
      "Recent run activities:",
      recentActivities.length > 0 ? recentActivities : "[none]"
    ].join("\n");

    const response = await this.client.responses.create({
      model: this.config.OPENAI_MODEL,
      instructions: AGENT_INSTRUCTIONS,
      input: context,
      max_output_tokens: this.config.OPENAI_MAX_OUTPUT_TOKENS,
      store: false
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error("OpenAI returned an empty response");
    }

    return outputText;
  }
}
