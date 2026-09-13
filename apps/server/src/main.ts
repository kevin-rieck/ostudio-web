import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";

export async function start(): Promise<void> {
  const server = await createServer();
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  await server.listen({ host: "0.0.0.0", port });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 15_000);
    try {
      await server.shutdown();
    } finally {
      clearTimeout(timeout);
    }
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await start();
}
