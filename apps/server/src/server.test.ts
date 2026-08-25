import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("server routes", () => {
  it("reports liveness without exposing application state", async () => {
    server = await createServer();

    const response = await server.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it.each(["/api/v1/missing", "/health/missing", "/assets/missing.js"])(
    "does not hide a missing reserved route behind the React shell: %s",
    async (url) => {
      server = await createServer();

      const response = await server.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    },
  );
});
