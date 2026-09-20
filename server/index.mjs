import http from "node:http";

import { channelList } from "./channels/index.mjs";
import { config } from "./config.mjs";
import { toHttpError } from "./lib/errors.mjs";
import { sendError } from "./lib/http.mjs";
import { createLogger } from "./lib/logger.mjs";
import { ensureDirs } from "./lib/media-store.mjs";
import { dispatch } from "./routes/index.mjs";

const log = createLogger("server");

async function main() {
  await ensureDirs();

  const server = http.createServer((req, res) => {
    const { pathname, search } = new URL(req.url, "http://bff.local");
    dispatch({ req, res, pathname, search }).catch((error) => {
      const httpError = toHttpError(error);
      if (httpError.status >= 500) log.error(`${req.method} ${req.url} -> ${httpError.status}: ${httpError.message}`);
      if (!res.headersSent) sendError(res, httpError);
      else res.end();
    });
  });

  server.listen(config.port, "0.0.0.0", () => {
    const channels = channelList()
      .map((channel) => `${channel.id}${channel.enabled && !channel.enabled() ? "(disabled)" : ""}`)
      .join(", ");
    log.info(`BFF listening on :${config.port}`);
    log.info(`基础渠道: ${channels}`);
  });

  const shutdown = (signal) => {
    log.info(`收到 ${signal}，停止服务`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  log.error("服务启动失败", error.message);
  process.exit(1);
});
