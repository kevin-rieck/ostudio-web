import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(repositoryRoot, "testdata", "conformance");
const contractPath = path.join(repositoryRoot, "api", "openapi.yaml");

const expectedFixtureKinds = [
  "diagnostic-redaction",
  "limits",
  "read-only-transitions",
  "saved-connection-secret-stripping",
  "scalar-normalization",
  "search-ordering",
  "timeout-classification",
  "transport-safety",
] as const;

const requiredSchemas = [
  "ApiError",
  "BuildInfo",
  "HealthStatus",
  "Snapshot",
  "EventEnvelope",
  "OperationId",
  "MutationChallenge",
  "OperationOutcome",
] as const;

const forbiddenModelProperty = /password|cookie|privateKey|certificateContents|hostPath|mutationValue|methodInputs?|methodOutputs?/i;
const lowerCamelCase = /^[a-z][A-Za-z0-9]*$/;

type JsonObject = Record<string, unknown>;

export interface ContractCheckResult {
  fixtureCount: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, description: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${description} must be a non-empty array`);
  }
  return value;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path.relative(repositoryRoot, filePath)} is not valid JSON: ${detail}`, { cause: error });
  }
}

function requireField(object: JsonObject, field: string, description: string): unknown {
  if (!(field in object)) {
    throw new Error(`${description} is missing ${field}`);
  }
  return object[field];
}

function validateFixturePayload(relativePath: string, fixture: JsonObject, kind: string): void {
  switch (kind) {
    case "scalar-normalization": {
      const cases = requireArray(fixture.cases, `${relativePath}.cases`);
      for (const value of cases) {
        const scalar = requireObject(value, `${relativePath}.cases entry`);
        requireString(scalar.dataType, `${relativePath}.cases.dataType`);
        requireField(scalar, "input", `${relativePath}.cases entry`);
        requireField(scalar, "normalized", `${relativePath}.cases entry`);
        if (["Int64", "UInt64"].includes(String(scalar.dataType)) && typeof scalar.normalized !== "string") {
          throw new Error(`${relativePath} must keep ${String(scalar.dataType)} as a string`);
        }
      }
      requireArray(fixture.rejected, `${relativePath}.rejected`);
      return;
    }
    case "search-ordering": {
      const candidates = requireArray(fixture.candidates, `${relativePath}.candidates`);
      const ordered = requireArray(fixture.orderedNodeIds, `${relativePath}.orderedNodeIds`);
      const candidateIds = candidates.map((value) => requireString(requireObject(value, `${relativePath}.candidates entry`).nodeId, `${relativePath}.candidates.nodeId`));
      const orderedIds = ordered.map((value) => requireString(value, `${relativePath}.orderedNodeIds entry`));
      if (new Set(candidateIds).size !== candidateIds.length || candidateIds.length !== orderedIds.length || candidateIds.some((id) => !orderedIds.includes(id))) {
        throw new Error(`${relativePath} must order every candidate exactly once`);
      }
      return;
    }
    case "read-only-transitions": {
      const initialState = requireObject(fixture.initialState, `${relativePath}.initialState`);
      if (initialState.readOnly !== true) {
        throw new Error(`${relativePath}.initialState must start in Read-Only Mode`);
      }
      for (const value of requireArray(fixture.transitions, `${relativePath}.transitions`)) {
        const transition = requireObject(value, `${relativePath}.transitions entry`);
        if (typeof transition.readOnly !== "boolean" || transition.generationChanges !== true) {
          throw new Error(`${relativePath} transitions must record a safety generation change`);
        }
      }
      requireArray(fixture.rejectedRequests, `${relativePath}.rejectedRequests`);
      return;
    }
    case "limits": {
      const limits = requireArray(fixture.limits, `${relativePath}.limits`);
      for (const value of limits) {
        const limit = requireObject(value, `${relativePath}.limits entry`);
        requireString(limit.name, `${relativePath}.limits.name`);
        if (typeof limit.maximum !== "number" || !Number.isInteger(limit.maximum) || limit.maximum < 1) {
          throw new Error(`${relativePath}.limits.maximum must be a positive integer`);
        }
        requireString(limit.atMaximum, `${relativePath}.limits.atMaximum`);
        requireString(limit.overMaximum, `${relativePath}.limits.overMaximum`);
      }
      return;
    }
    case "timeout-classification": {
      const deadlines = requireObject(fixture.defaultDeadlinesMilliseconds, `${relativePath}.defaultDeadlinesMilliseconds`);
      for (const operation of ["read", "write", "methodCall"]) {
        if (typeof deadlines[operation] !== "number" || deadlines[operation] <= 0) {
          throw new Error(`${relativePath} must define a positive ${operation} deadline`);
        }
      }
      for (const value of requireArray(fixture.cases, `${relativePath}.cases`)) {
        const timeoutCase = requireObject(value, `${relativePath}.cases entry`);
        requireString(timeoutCase.operation, `${relativePath}.cases.operation`);
        requireString(timeoutCase.completionEvidence, `${relativePath}.cases.completionEvidence`);
        requireString(timeoutCase.outcome, `${relativePath}.cases.outcome`);
        if (timeoutCase.outcome === "unknown" && timeoutCase.readOnly !== true) {
          throw new Error(`${relativePath} unknown outcomes must restore Read-Only Mode`);
        }
      }
      return;
    }
    case "diagnostic-redaction": {
      const safeRecord = requireObject(fixture.safeRecord, `${relativePath}.safeRecord`);
      const removedFields = requireArray(fixture.removedFields, `${relativePath}.removedFields`);
      for (const field of removedFields) {
        if (typeof field !== "string" || field in safeRecord) {
          throw new Error(`${relativePath} retained a redacted diagnostic field`);
        }
      }
      return;
    }
    case "saved-connection-secret-stripping": {
      const stored = requireObject(fixture.stored, `${relativePath}.stored`);
      const strippedFields = requireArray(fixture.strippedFields, `${relativePath}.strippedFields`);
      for (const field of strippedFields) {
        if (typeof field !== "string" || field in stored) {
          throw new Error(`${relativePath} persisted a stripped Saved Connection field`);
        }
      }
      return;
    }
    case "transport-safety": {
      const snapshot = requireObject(fixture.snapshot, `${relativePath}.snapshot`);
      const event = requireObject(fixture.event, `${relativePath}.event`);
      if (typeof snapshot.sequence !== "number" || typeof event.sequence !== "number" || event.sequence <= snapshot.sequence) {
        throw new Error(`${relativePath} must advance event sequence after its snapshot`);
      }
      requireString(snapshot.buildVersion, `${relativePath}.snapshot.buildVersion`);
      requireString(event.buildVersion, `${relativePath}.event.buildVersion`);
      requireArray(fixture.rejectedFields, `${relativePath}.rejectedFields`);
      return;
    }
    default:
      throw new Error(`${relativePath}.kind is not a supported conformance kind`);
  }
}

function validateFixture(filePath: string, fixture: unknown): { id: string; appliesToWeb: boolean; kind: string } {
  const relativePath = path.relative(repositoryRoot, filePath);
  const object = requireObject(fixture, relativePath);
  requireString(object.fixtureVersion, `${relativePath}.fixtureVersion`);
  const id = requireString(object.id, `${relativePath}.id`);
  const targets = requireArray(object.applicableTargets, `${relativePath}.applicableTargets`);

  for (const target of targets) {
    if (target !== "web" && target !== "desktop-and-web") {
      throw new Error(`${relativePath}.applicableTargets contains an unknown target`);
    }
  }
  if (targets.includes("desktop-and-web")) {
    requireString(object.sourceVersion, `${relativePath}.sourceVersion`);
  }

  const kind = requireString(object.kind, `${relativePath}.kind`);
  if (!(expectedFixtureKinds as readonly string[]).includes(kind)) {
    throw new Error(`${relativePath}.kind is not a supported conformance kind`);
  }
  validateFixturePayload(relativePath, object, kind);
  return { id, appliesToWeb: targets.includes("web") || targets.includes("desktop-and-web"), kind };
}

function validateSchemaProperties(schemaName: string, schema: unknown): void {
  if (!isObject(schema)) {
    throw new Error(`components.schemas.${schemaName} must be an object`);
  }
  if (schema.type === "object" && schema.additionalProperties !== false) {
    throw new Error(`components.schemas.${schemaName} must reject undeclared properties`);
  }
  const properties = schema.properties;
  if (properties === undefined) {
    return;
  }
  const propertyObject = requireObject(properties, `components.schemas.${schemaName}.properties`);
  for (const propertyName of Object.keys(propertyObject)) {
    if (!lowerCamelCase.test(propertyName)) {
      throw new Error(`components.schemas.${schemaName} has non-lower-camel property ${propertyName}`);
    }
    if (forbiddenModelProperty.test(propertyName)) {
      throw new Error(`components.schemas.${schemaName} exposes prohibited property ${propertyName}`);
    }
  }
  if (Array.isArray(schema.required)) {
    for (const required of schema.required) {
      if (typeof required !== "string" || !(required in propertyObject)) {
        throw new Error(`components.schemas.${schemaName} requires an undeclared property`);
      }
    }
  }
}

function validateOpenApi(contract: unknown): void {
  const root = requireObject(contract, "api/openapi.yaml");
  if (root.openapi !== "3.1.0") {
    throw new Error("api/openapi.yaml must use OpenAPI 3.1.0");
  }
  requireObject(root.paths, "api/openapi.yaml.paths");
  const components = requireObject(root.components, "api/openapi.yaml.components");
  const schemas = requireObject(components.schemas, "api/openapi.yaml.components.schemas");

  for (const schemaName of requiredSchemas) {
    if (!(schemaName in schemas)) {
      throw new Error(`api/openapi.yaml is missing schema ${schemaName}`);
    }
  }
  for (const [schemaName, schema] of Object.entries(schemas)) {
    validateSchemaProperties(schemaName, schema);
  }
  const operationIds = new Set<string>();
  for (const [route, pathItemValue] of Object.entries(root.paths)) {
    const pathItem = requireObject(pathItemValue, `path ${route}`);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) {
        continue;
      }
      const operation = requireObject(operationValue, `${method.toUpperCase()} ${route}`);
      const operationId = requireString(operation.operationId, `${method.toUpperCase()} ${route}.operationId`);
      if (!lowerCamelCase.test(operationId) || operationIds.has(operationId)) {
        throw new Error(`operationId ${operationId} is missing, duplicated, or not lower camel case`);
      }
      operationIds.add(operationId);
    }
  }

  const mutationRequest = schemas.PrepareMutationRequest;
  if (!isObject(mutationRequest) || !isObject(mutationRequest.properties)) {
    throw new Error("mutation preparation must define a request model");
  }
  for (const field of ["operationId", "kind", "targetNodeId", "inputDigest"]) {
    if (!(field in mutationRequest.properties)) {
      throw new Error(`mutation preparation is missing ${field}`);
    }
  }
  const challenge = schemas.MutationChallenge;
  if (!isObject(challenge) || !isObject(challenge.properties)) {
    throw new Error("mutation challenge must define a model");
  }
  for (const field of ["operationId", "challenge", "expiresAt", "controllerGeneration", "connectionGeneration", "safetyGeneration"]) {
    if (!(field in challenge.properties)) {
      throw new Error(`mutation challenge is missing ${field}`);
    }
  }
}

export function checkContract(): ContractCheckResult {
  validateOpenApi(readJson(contractPath));

  const fixtureFiles = readdirSync(fixtureDirectory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => path.join(fixtureDirectory, fileName));
  const ids = new Set<string>();
  const kinds = new Set<string>();
  let fixtureCount = 0;

  for (const filePath of fixtureFiles) {
    const fixture = readJson(filePath);
    const validated = validateFixture(filePath, fixture);
    if (!validated.appliesToWeb) {
      continue;
    }
    if (ids.has(validated.id)) {
      throw new Error(`duplicate conformance fixture id ${validated.id}`);
    }
    ids.add(validated.id);
    kinds.add(validated.kind);
    fixtureCount += 1;
  }

  const fixtureKinds = [...kinds].sort();
  if (fixtureKinds.length !== expectedFixtureKinds.length || fixtureKinds.some((kind, index) => kind !== expectedFixtureKinds[index])) {
    throw new Error(`conformance kinds must be exactly ${expectedFixtureKinds.join(", ")}`);
  }
  return { fixtureCount };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  try {
    const result = checkContract();
    console.log(`contract ok: ${result.fixtureCount} web-applicable fixtures`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
