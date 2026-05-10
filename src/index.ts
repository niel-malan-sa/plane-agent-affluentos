import pino from "pino";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { PlaneApiClient } from "./plane-api.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const db = new AppDatabase(config.databasePathAbsolute);
  const planeApi = new PlaneApiClient(config, db, logger);
  const app = createServer(config, db, planeApi, logger);

  app.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, "Plane agent service listening");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
