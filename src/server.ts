import express, { type Request, type Response } from "express";
import pinoHttp from "pino-http";
import type { Logger } from "pino";
import type { RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { PlaneApiClient } from "./plane-api.js";
import { RunWorker, buildScopeMatrix } from "./runtime.js";
import { PlaneWebhookService, verifyPlaneSignature } from "./webhook-service.js";
import { createRandomState, escapeHtml } from "./utils.js";

export function createServer(
  config: AppConfig,
  db: AppDatabase,
  planeApi: PlaneApiClient,
  worker: RunWorker,
  logger: Logger
) {
  const app = express();
  const webhookService = new PlaneWebhookService(config, db, planeApi, logger);
  const httpLogger = pinoHttp as unknown as (options: { logger: Logger }) => RequestHandler;

  app.disable("x-powered-by");
  app.use(httpLogger({ logger }));

  app.get("/health", async (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      role: config.APP_ROLE,
      database: (await db.healthcheck()) ? "ok" : "error"
    });
  });

  app.get("/health/worker", async (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      role: config.APP_ROLE,
      queueDepth: await db.countActiveJobs()
    });
  });

  app.get("/setup", async (_request: Request, response: Response) => {
    if (config.APP_ROLE === "worker") {
      response.status(503).send("Setup is not served by the worker role.");
      return;
    }

    await db.purgeExpiredOauthStates(config.STATE_TTL_SECONDS);
    const state = createRandomState();
    await db.saveOauthState(state, "install");

    const url = new URL("/auth/o/authorize-app/", config.PLANE_BASE_URL);
    url.searchParams.set("client_id", config.PLANE_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.PLANE_REDIRECT_URI);
    url.searchParams.set("state", state);
    response.redirect(302, url.toString());
  });

  app.get("/oauth/user/connect", async (request: Request, response: Response) => {
    if (config.APP_ROLE === "worker") {
      response.status(503).send("User OAuth initiation is not served by the worker role.");
      return;
    }

    const workspaceId = typeof request.query.workspaceId === "string" ? request.query.workspaceId : "";
    const userId = typeof request.query.userId === "string" ? request.query.userId : "";

    if (!workspaceId || !userId) {
      response.status(400).send("workspaceId and userId are required");
      return;
    }

    const state = createRandomState();
    await db.saveOauthState(state, "user_token", JSON.stringify({ workspaceId, userId }));

    const url = new URL("/auth/o/authorize-app/", config.PLANE_BASE_URL);
    url.searchParams.set("client_id", config.PLANE_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.PLANE_REDIRECT_URI);
    url.searchParams.set("state", state);
    response.redirect(302, url.toString());
  });

  app.get("/oauth/callback", async (request: Request, response: Response) => {
    if (config.APP_ROLE === "worker") {
      response.status(503).send("OAuth callback is not served by the worker role.");
      return;
    }

    try {
      const state = typeof request.query.state === "string" ? request.query.state : "";
      const consumed = await db.consumeOauthState(state, config.STATE_TTL_SECONDS);
      if (!state || !consumed.valid) {
        response.status(400).send("Invalid or expired OAuth state");
        return;
      }

      const oauthError = typeof request.query.error === "string" ? request.query.error : "";
      if (oauthError) {
        const detail =
          typeof request.query.error_description === "string" ? request.query.error_description : "";
        response.status(400).send(detail ? `Plane OAuth error: ${oauthError} (${detail})` : oauthError);
        return;
      }

      if (consumed.mode === "user_token") {
        const metadata = consumed.metadataJson ? JSON.parse(consumed.metadataJson) : {};
        const code = typeof request.query.code === "string" ? request.query.code : "";
        if (!code || !metadata.workspaceId || !metadata.userId) {
          response.status(400).send("Missing user token callback metadata");
          return;
        }
        const userToken = await planeApi.finalizeUserAuthorization(
          String(metadata.workspaceId),
          String(metadata.userId),
          code
        );
        response.status(200).type("html").send(`
          <!doctype html>
          <html lang="en">
            <body style="font-family:sans-serif;max-width:720px;margin:3rem auto;line-height:1.5">
              <h1>Plane user authorization complete</h1>
              <p>Workspace: <code>${escapeHtml(userToken.workspaceId)}</code></p>
              <p>User: <code>${escapeHtml(userToken.userId)}</code></p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
        return;
      }

      const appInstallationId =
        typeof request.query.app_installation_id === "string" ? request.query.app_installation_id : "";
      if (!appInstallationId) {
        response.status(400).send("Missing app_installation_id");
        return;
      }

      const installation = await planeApi.finalizeInstallation(appInstallationId);
      response.status(200).type("html").send(`
        <!doctype html>
        <html lang="en">
          <body style="font-family:sans-serif;max-width:720px;margin:3rem auto;line-height:1.5">
            <h1>Plane agent installed</h1>
            <p>Workspace: <code>${escapeHtml(installation.workspaceSlug)}</code></p>
            <p>Workspace ID: <code>${escapeHtml(installation.workspaceId)}</code></p>
            <p>Installation ID: <code>${escapeHtml(installation.appInstallationId)}</code></p>
            <p>You can close this window.</p>
          </body>
        </html>
      `);
    } catch (error) {
      logger.error({ err: error }, "Plane OAuth callback failed");
      response.status(500).send("Plane OAuth callback failed");
    }
  });

  app.get("/auth/external/:provider", (request: Request, response: Response) => {
    const provider = String(request.params.provider);
    const configuredUrl =
      provider === "github"
        ? config.EXTERNAL_AUTH_GITHUB_URL
        : provider === "docs"
          ? config.EXTERNAL_AUTH_DOCS_URL
          : undefined;

    if (configuredUrl) {
      const url = new URL(configuredUrl);
      for (const [key, value] of Object.entries(request.query)) {
        if (typeof value === "string") {
          url.searchParams.set(key, value);
        }
      }
      response.redirect(302, url.toString());
      return;
    }

    response.status(501).type("html").send(`
      <!doctype html>
      <html lang="en">
        <body style="font-family:sans-serif;max-width:720px;margin:3rem auto;line-height:1.5">
          <h1>External authorization requested</h1>
          <p>The Plane agent asked for <code>${escapeHtml(provider)}</code> authorization.</p>
          <p>No external auth URL is configured for this provider, so the request cannot continue yet.</p>
        </body>
      </html>
    `);
  });

  app.post(
    "/webhooks/plane",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request: Request, response: Response) => {
      if (config.APP_ROLE === "worker") {
        response.status(503).json({ error: "Webhook ingress is not served by the worker role" });
        return;
      }

      const signature = request.header("X-Plane-Signature");
      const deliveryId = request.header("X-Plane-Delivery");
      const event = request.header("X-Plane-Event");

      if (!signature || !deliveryId || !event) {
        response.status(400).json({ error: "Missing required Plane webhook headers" });
        return;
      }

      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (!verifyPlaneSignature(rawBody, signature, config.PLANE_WEBHOOK_SECRET)) {
        response.status(403).json({ error: "Invalid Plane webhook signature" });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      } catch {
        response.status(400).json({ error: "Invalid JSON payload" });
        return;
      }

      const reservation = await webhookService.reserveDelivery(deliveryId, event, rawBody, payload);
      if (!reservation.accepted) {
        response.status(200).json({ status: "duplicate", deliveryId, existingStatus: reservation.existingStatus });
        return;
      }

      await webhookService.enqueueDelivery(deliveryId, event, payload);
      response.status(200).json({ status: "accepted", deliveryId, event });
    }
  );

  app.use(express.json({ limit: "1mb" }));

  app.get("/admin/installations/:workspaceId", async (request: Request, response: Response) => {
    const installation = await planeApi.getInstallationForWorkspace(String(request.params.workspaceId));
    if (!installation) {
      response.status(404).json({ error: "Installation not found" });
      return;
    }
    response.json(installation);
  });

  app.post("/admin/installations/:workspaceId/healthcheck", async (request: Request, response: Response) => {
    const installation = await planeApi.getInstallationForWorkspace(String(request.params.workspaceId));
    if (!installation) {
      response.status(404).json({ error: "Installation not found" });
      return;
    }

    const refreshed = await planeApi.healthcheckInstallation(installation);
    response.json(refreshed);
  });

  app.get("/admin/runs/:runId", async (request: Request, response: Response) => {
    const runId = String(request.params.runId);
    const state = await db.getRunState(runId);
    if (!state) {
      response.status(404).json({ error: "Run state not found" });
      return;
    }
    response.json({
      state,
      auditLogs: await db.listAuditLogs(runId, 50)
    });
  });

  app.get("/admin/jobs", async (_request: Request, response: Response) => {
    response.json({
      jobs: await db.listRunJobs(50)
    });
  });

  app.get("/admin/scope-matrix", (_request: Request, response: Response) => {
    response.json({
      requestedScopes: config.oauthScopes,
      families: buildScopeMatrix(),
      workerFamilies: worker.getScopeMatrix()
    });
  });

  return app;
}
