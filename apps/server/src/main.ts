import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";

export async function start(): Promise<void> {
  const server = await createServer();
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  await server.listen({ host: "0.0.0.0", port });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await start();
}
