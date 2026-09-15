import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
type Schema = JsonObject;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(repositoryRoot, "api", "openapi.yaml");
const outputPath = path.join(repositoryRoot, "packages", "contracts", "src", "index.ts");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refName(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.$ref !== "string") return undefined;
  const prefix = "#/components/schemas/";
  return value.$ref.startsWith(prefix) ? value.$ref.slice(prefix.length) : undefined;
}

function stringLiteral(value: unknown): string {
  return JSON.stringify(String(value));
}

function schemaType(schema: Schema): string {
  const reference = refName(schema);
  if (reference) return reference;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((item) => schemaType(isObject(item) ? item : {})).join(" | ");
  if (schema.type === "array") {
    const itemType = isObject(schema.items) ? schemaType(schema.items) : "unknown";
    return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
  }
  if (Array.isArray(schema.enum)) return schema.enum.map(stringLiteral).join(" | ");
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "string") return "string";
  if (schema.type === "object") return "Record<string, unknown>";
  return "unknown";
}

function renderSchema(name: string, schema: Schema): string {
  if (schema.type !== "object" || !isObject(schema.properties)) {
    return `export type ${name} = ${schemaType(schema)};`;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const fields = Object.entries(schema.properties).map(([field, value]) => {
    const type = schemaType(isObject(value) ? value : {});
    return `  ${field}${required.has(field) ? "" : "?"}: ${type};`;
  });
  return `export interface ${name} {\n${fields.join("\n")}\n}`;
}

function operationResultType(operation: JsonObject): string {
  const responses = isObject(operation.responses) ? operation.responses : {};
  for (const [status, responseValue] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(status) || !isObject(responseValue)) continue;
    const content = isObject(responseValue.content) ? responseValue.content : {};
    const json = isObject(content["application/json"]) ? content["application/json"] : undefined;
    const schema = json && isObject(json.schema) ? json.schema : undefined;
    return schema ? schemaType(schema) : "void";
  }
  return "void";
}

function renderClient(contract: JsonObject): string {
  const paths = isObject(contract.paths) ? contract.paths : {};
  const schemas = isObject(contract.components) && isObject(contract.components.schemas) ? contract.components.schemas : {};
  const loginSchema = schemas.LoginRequest ?? {};
  type ClientParameter = { name: string; location: "path" | "query"; type: string; required: boolean };
  type ClientOperation = { name: string; method: string; route: string; requestType?: string; resultType: string; parameters: ClientParameter[] };
  const operations: ClientOperation[] = [];
  for (const [route, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) continue;
    for (const [method, operationValue] of Object.entries(pathItemValue)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method) || !isObject(operationValue)) continue;
      const name = typeof operationValue.operationId === "string" ? operationValue.operationId : undefined;
      if (!name) continue;
      const requestBody = isObject(operationValue.requestBody) ? operationValue.requestBody : undefined;
      const content = requestBody && isObject(requestBody.content) ? requestBody.content : undefined;
      const json = content && isObject(content["application/json"]) ? content["application/json"] : undefined;
      const requestSchema = json && isObject(json.schema) ? refName(json.schema) : undefined;
      const parameters: ClientParameter[] = [];
      for (const parameterValue of Array.isArray(operationValue.parameters) ? operationValue.parameters : []) {
        if (!isObject(parameterValue) || typeof parameterValue.name !== "string" || (parameterValue.in !== "path" && parameterValue.in !== "query")) continue;
        parameters.push({ name: parameterValue.name, location: parameterValue.in, type: isObject(parameterValue.schema) ? schemaType(parameterValue.schema) : "string", required: parameterValue.required === true });
      }
      operations.push({ name, method: method.toUpperCase(), route, requestType: requestSchema, resultType: operationResultType(operationValue), parameters });
    }
  }
  const methods = operations.map(({ name, method, route, requestType, resultType, parameters }) => {
    const pathParameters = parameters.filter((parameter) => parameter.location === "path");
    const queryParameters = parameters.filter((parameter) => parameter.location === "query");
    const argumentsList = [
      ...pathParameters.map((parameter) => `${parameter.name}: ${parameter.type}`),
      ...(requestType ? [`request: ${requestType}`] : []),
      ...queryParameters.map((parameter) => `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.type}`),
    ];
    const returnType = resultType === "void" ? "Promise<void>" : `Promise<${resultType}>`;
    const pathExpression = pathParameters.reduce((expression, parameter) => `${expression}.replace("{${parameter.name}}", encodeURIComponent(String(${parameter.name})))`, JSON.stringify(route));
    const querySetup = queryParameters.length === 0 ? "" : `\n    const query = new URLSearchParams();\n${queryParameters.map((parameter) => `    if (${parameter.name} !== undefined) query.set("${parameter.name}", String(${parameter.name}));`).join("\n")}\n    const route = ${pathExpression} + (query.toString() ? "?" + query.toString() : "");`;
    const routeArgument = queryParameters.length === 0 ? pathExpression : "route";
    const body = requestType ? ", JSON.stringify(request)" : "";
    return `  ${name}(${argumentsList.join(", ")}): ${returnType} {${querySetup}\n    return send<${resultType === "void" ? "void" : resultType}>("${method}", ${routeArgument}${body});\n  }`;
  });
  return `
export const loginRequestSchema = ${JSON.stringify(loginSchema)} as const;

export interface ContractResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface ContractRequestInit {
  method?: string;
  credentials?: "same-origin";
  headers?: Record<string, string>;
  body?: string;
}

export type ContractTransport = (input: string, init?: ContractRequestInit) => Promise<ContractResponse>;

export class ApiClientError extends Error {
  public constructor(public readonly status: number, public readonly error?: ApiError) {
    super(error?.message ?? "The request could not be completed.");
    this.name = "ApiClientError";
  }
}

const defaultTransport: ContractTransport = (input, init) => {
  const transport = (globalThis as { fetch?: ContractTransport }).fetch;
  if (!transport) throw new Error("A browser fetch implementation is required.");
  return transport(input, init);
};

export interface ApiClient {
${operations.map(({ name, requestType, resultType, parameters }) => `  ${name}(${[...parameters.filter((parameter) => parameter.location === "path").map((parameter) => `${parameter.name}: ${parameter.type}`), ...(requestType ? [`request: ${requestType}`] : []), ...parameters.filter((parameter) => parameter.location === "query").map((parameter) => `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.type}`)].join(", ")}): ${resultType === "void" ? "Promise<void>" : `Promise<${resultType}>`};`).join("\n")}
}

export function createApiClient(transport: ContractTransport = defaultTransport, baseUrl = ""): ApiClient {
  async function send<T>(method: string, route: string, body?: string): Promise<T> {
    const response = await transport(baseUrl + route, {
      method,
      credentials: "same-origin",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    });
    if (!response.ok) {
      let error: ApiError | undefined;
      try {
        const payload = await response.json();
        if (isApiError(payload)) error = payload;
      } catch {
        // Keep transport failures generic and secret-free.
      }
      throw new ApiClientError(response.status, error);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  return {
${methods.join(",\n\n")}
  };
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" && typeof (value as { message?: unknown }).message === "string" && typeof (value as { correlationId?: unknown }).correlationId === "string";
}
`;
}

export function generateContractSource(): string {
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as JsonObject;
  const schemasRoot = isObject(contract.components) && isObject(contract.components.schemas) ? contract.components.schemas : {};
  const models = Object.entries(schemasRoot).map(([name, schema]) => renderSchema(name, isObject(schema) ? schema : {}));
  return `// Generated by scripts/generate-contract.ts from api/openapi.yaml. Do not edit.\n\n${models.join("\n\n")}\n${renderClient(contract)}`;
}

export function generateContract(): void {
  writeFileSync(outputPath, generateContractSource());
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) generateContract();
