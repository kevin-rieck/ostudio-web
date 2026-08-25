import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });

  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async () => ({ status: "ready" }));

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const assetsDirectory =
    process.env.OSTUDIO_WEB_ASSETS_DIR ??
    path.resolve(moduleDirectory, "../../client/dist");

  const hasClientAssets = await directoryExists(assetsDirectory);
  if (hasClientAssets) {
    await server.register(fastifyStatic, {
      root: assetsDirectory,
      wildcard: false,
    });
  }

  server.setNotFoundHandler(async (request, reply) => {
    const reservedPath = ["/api/", "/health/", "/assets/"].some((prefix) =>
      request.url.startsWith(prefix),
    );
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;

    if (hasClientAssets && !reservedPath && acceptsHtml) {
      return reply.sendFile("index.html");
    }

    return reply.code(404).send({ error: "not_found" });
  });

  return server;
}
