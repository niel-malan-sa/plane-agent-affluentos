import pino from "pino";
import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { OpenAIResponder } from "./openai-client.js";
import { PlaneApiClient } from "./plane-api.js";
import { RunWorker } from "./runtime.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const db = new AppDatabase(config);
  await db.migrate();

  const planeApi = new PlaneApiClient(config, db, logger);
  const model = config.APP_ROLE === "ingress" ? null : new OpenAIResponder(config);
  let server: Server | null = null;
  const worker = new RunWorker(config, db, planeApi, model, logger);
  const app = createServer(config, db, planeApi, worker, logger);

  if (config.APP_ROLE === "all" || config.APP_ROLE === "worker") {
    worker.start();
  }

  server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT, role: config.APP_ROLE }, "Plane agent service listening");
  });

  const shutdown = async () => {
    worker.stop();
    await worker.waitForIdle();
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await db.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
