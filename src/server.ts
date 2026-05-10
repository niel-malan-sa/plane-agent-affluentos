import express, { type Request, type Response } from "express";
import type { Logger } from "pino";
import pinoHttp from "pino-http";
import type { RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { OpenAIResponder } from "./openai-client.js";
import { PlaneApiClient } from "./plane-api.js";
import { PlaneWebhookService, verifyPlaneSignature } from "./webhook-service.js";
import { createRandomState, escapeHtml } from "./utils.js";

export function createServer(
  config: AppConfig,
  db: AppDatabase,
  planeApi: PlaneApiClient,
  logger: Logger
) {
  const app = express();
  const openAiResponder = new OpenAIResponder(config);
  const webhookService = new PlaneWebhookService(config, db, planeApi, openAiResponder, logger);
  const httpLogger = pinoHttp as unknown as (options: { logger: Logger }) => RequestHandler;

  app.disable("x-powered-by");
  app.use(
    httpLogger({
      logger
    })
  );

  app.get("/health", (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      database: db.healthcheck() ? "ok" : "error"
    });
  });

  app.get("/setup", (_request: Request, response: Response) => {
    db.purgeExpiredOauthStates(config.STATE_TTL_SECONDS);

    const state = createRandomState();
    db.saveOauthState(state);

    const url = new URL("/auth/o/authorize-app/", config.PLANE_BASE_URL);
    url.searchParams.set("client_id", config.PLANE_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.PLANE_REDIRECT_URI);
    url.searchParams.set("state", state);

    response.redirect(302, url.toString());
  });

  app.get("/oauth/callback", async (request: Request, response: Response) => {
    try {
      const state = typeof request.query.state === "string" ? request.query.state : "";
      if (!state || !db.consumeOauthState(state, config.STATE_TTL_SECONDS)) {
        response.status(400).send("Invalid or expired OAuth state");
        return;
      }

      const appInstallationId =
        typeof request.query.app_installation_id === "string" ? request.query.app_installation_id : "";

      if (!appInstallationId) {
        response.status(400).send("Missing app_installation_id");
        return;
      }

      const installation = await planeApi.finalizeInstallation(appInstallationId);

      response
        .status(200)
        .type("html")
        .send(
          `
            <!doctype html>
            <html lang="en">
              <head>
                <meta charset="utf-8" />
                <title>Plane agent installed</title>
                <style>
                  body { font-family: sans-serif; max-width: 720px; margin: 3rem auto; line-height: 1.5; }
                  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 4px; }
                </style>
              </head>
              <body>
                <h1>Plane agent installed</h1>
                <p>Workspace: <code>${escapeHtml(installation.workspaceSlug)}</code></p>
                <p>Workspace ID: <code>${escapeHtml(installation.workspaceId)}</code></p>
                <p>Installation ID: <code>${escapeHtml(installation.appInstallationId)}</code></p>
                <p>You can close this window.</p>
              </body>
            </html>
          `
        );
    } catch (error) {
      logger.error({ err: error }, "Plane OAuth callback failed");
      response.status(500).send("Plane OAuth callback failed");
    }
  });

  app.post(
    "/webhooks/plane",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request: Request, response: Response) => {
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

      const reservation = webhookService.reserveDelivery(deliveryId, event, rawBody, payload);
      if (!reservation.accepted) {
        response.status(200).json({ status: "duplicate", deliveryId, existingStatus: reservation.existingStatus });
        return;
      }

      response.status(202).json({ status: "accepted", deliveryId, event });

      void webhookService.processDelivery(deliveryId, event, payload);
    }
  );

  return app;
}
