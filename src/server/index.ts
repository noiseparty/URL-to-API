import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BASE, createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/index.js next to dist/public/. In dev (tsx) the same relative path holds from src/server.
const publicDir = process.env.PUBLIC_DIR ?? resolve(here, "../../dist/public");
const port = Number(process.env.PORT ?? 3103);
const host = process.env.HOST ?? "0.0.0.0";

const server = createServer(createApp({ publicDir }));
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.listen(port, host, () => {
  console.log(`scrape demo listening on http://${host}:${port}${BASE}/`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
