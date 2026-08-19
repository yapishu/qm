import { createServer } from "node:http";
import { CORE_API_URL, CORE_SIGNING_SECRET, portFromEnv } from "../../chassis/src/env.ts";
import { CoreClient } from "./core.ts";
import { TlonController } from "./controller.ts";

const controller = new TlonController(new CoreClient(CORE_API_URL, CORE_SIGNING_SECRET));
controller.start();

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(controller.health()));
});

server.listen(portFromEnv(8080), "0.0.0.0");

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await controller.stop();
}

process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
process.on("SIGINT", () => void stop().then(() => process.exit(0)));
