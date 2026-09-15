import { describe, expect, it } from "vitest";
import { ApiClientError, createApiClient, type ContractResponse, type ContractTransport } from "./index.js";

function response(status: number, payload?: unknown): ContractResponse {
  return { ok: status < 400, status, json: async () => payload };
}

describe("generated contract client", () => {
  it("uses the OpenAPI auth routes and projects safe errors", async () => {
    const calls: Array<{ input: string; init?: Parameters<ContractTransport>[1] }> = [];
    const transport: ContractTransport = async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/login")) return response(204);
      return response(200, { authenticated: true, insecureDevelopment: false });
    };
    const client = createApiClient(transport, "");
    await client.loginAdmin({ username: "admin", password: "correct horse battery staple" });
    await expect(client.getAuthenticationSession()).resolves.toEqual({
      authenticated: true,
      insecureDevelopment: false,
    });
    expect(calls[0]).toMatchObject({
      input: "/api/v1/auth/login",
      init: { method: "POST", credentials: "same-origin" },
    });

    const failing = createApiClient(async () =>
      response(401, {
        code: "authentication_required",
        message: "Nope",
        correlationId: "cor-01J00000000000000000000000",
      }),
    );
    await expect(failing.logoutAdmin()).rejects.toBeInstanceOf(ApiClientError);
  });
});
