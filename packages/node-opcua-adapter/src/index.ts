import { createHash } from "node:crypto";
import {
  AccessLevelFlag,
  AttributeIds,
  BrowseDirection,
  DataType,
  MessageSecurityMode,
  NumericRange,
  OPCUAClient,
  SecurityPolicy,
  TimestampsToReturn,
  UserTokenType,
  Variant,
  VariantArrayType,
  coerceInt64,
  coerceNodeId,
  coerceUInt64,
} from "node-opcua";
import type {
  ApplicationDescription,
  Argument,
  BrowseResult,
  ClientMonitoredItem,
  ClientSession,
  ClientSubscription,
  EndpointDescription,
  OPCUAClient as RawOpcuaClient,
  OPCUAClientOptions as RawOpcuaClientOptions,
  UserIdentityInfo,
} from "node-opcua";
import type {
  OpcUaBrowseRequest,
  OpcUaBrowseResult,
  OpcUaCallRequest,
  OpcUaCallResult,
  OpcUaClient,
  OpcUaClientOptions,
  OpcUaConnectRequest,
  OpcUaConnectionLoss,
  OpcUaDataType,
  OpcUaDiscoveryRequest,
  OpcUaDiscoveryResult,
  OpcUaEndpoint,
  OpcUaMethodArgument,
  OpcUaMethodDefinition,
  OpcUaMutationResult,
  OpcUaReadRequest,
  OpcUaReadResult,
  OpcUaReference,
  OpcUaSession,
  OpcUaSubscribeRequest,
  OpcUaSubscription,
  OpcUaVariant,
  OpcUaWriteRequest,
  OpcUaValueHandler,
  TransportValue,
} from "@ostudio/application";
import {
  boundedString,
  projectDataValue,
  projectLocalizedText,
  projectReference,
  projectStatusCode,
  projectVariant,
} from "./projection";

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_METHOD_TIMEOUT = 30_000;
const DEFAULT_MAX_BROWSE_REQUESTS = 250;
const DEFAULT_MAX_REFERENCES_PER_NODE = 1_024;
const MAX_BROWSE_REQUESTS = 250;
const MAX_REFERENCES_PER_NODE = 10_000;
const MAX_VARIANT_ARRAY_LENGTH = 1_024;
const MAX_VARIANT_DIMENSIONS = 1_024;
const VALUE_ATTRIBUTE = AttributeIds.Value;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

const dataTypeNodeIds: Record<number, OpcUaDataType> = {
  1: "Boolean",
  2: "SByte",
  3: "Byte",
  4: "Int16",
  5: "UInt16",
  6: "Int32",
  7: "UInt32",
  8: "Int64",
  9: "UInt64",
  10: "Float",
  11: "Double",
  12: "String",
  13: "DateTime",
  14: "Guid",
  15: "ByteString",
  16: "XmlElement",
  17: "NodeId",
  18: "ExpandedNodeId",
  19: "StatusCode",
  20: "QualifiedName",
  21: "LocalizedText",
  22: "ExtensionObject",
  23: "DataValue",
  24: "Variant",
  25: "DiagnosticInfo",
};

class DeadlineExceeded extends Error {}

export class NodeOpcuaAdapterError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_connected"
      | "discovery_failed"
      | "connection_failed"
      | "server_certificate_required"
      | "endpoint_not_found"
      | "operation_failed",
    message: string,
  ) {
    super(message);
    this.name = "NodeOpcuaAdapterError";
  }
}

export interface NodeOpcuaAdapterOptions extends OpcUaClientOptions {
  clientCertificateManager?: RawOpcuaClientOptions["clientCertificateManager"];
}

function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return Promise.reject(new NodeOpcuaAdapterError("invalid_request", "The operation deadline is invalid."));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), milliseconds);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function operationDeadline(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new NodeOpcuaAdapterError("invalid_request", "The operation deadline is invalid.");
  }
  return Date.now() + milliseconds;
}

function withDeadlineAt<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  return remaining > 0 ? withDeadline(operation, remaining) : Promise.reject(new DeadlineExceeded());
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new NodeOpcuaAdapterError("invalid_request", "The requested operation bound is invalid.");
  }
  return value;
}

function positiveBoundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = boundedLimit(value, fallback, maximum);
  if (limit < 1) throw new NodeOpcuaAdapterError("invalid_request", "The requested operation bound is invalid.");
  return limit;
}

function timeout(options: NodeOpcuaAdapterOptions, key: keyof NodeOpcuaAdapterOptions, fallback: number): number {
  const value = options[key];
  return typeof value === "number" ? value : fallback;
}

function fingerprint(certificate: Buffer | undefined): string | undefined {
  if (!certificate?.length) return undefined;
  return `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
}

function securityMode(value: OpcUaConnectRequest["securityMode"]): MessageSecurityMode {
  return MessageSecurityMode[value ?? "None"] as MessageSecurityMode;
}

function securityPolicy(value: string | undefined): SecurityPolicy {
  return (value ?? SecurityPolicy.None) as SecurityPolicy;
}

function endpointProjection(endpoint: EndpointDescription): OpcUaEndpoint {
  const mode = MessageSecurityMode[endpoint.securityMode] as OpcUaEndpoint["securityMode"];
  return {
    endpointUrl: boundedString(endpoint.endpointUrl ?? ""),
    securityMode: mode,
    securityPolicyUri: boundedString(endpoint.securityPolicyUri ?? ""),
    serverCertificateFingerprint: mode === "None" ? undefined : fingerprint(endpoint.serverCertificate),
  };
}

function mutationFailure(error: unknown): OpcUaMutationResult {
  const code = error instanceof DeadlineExceeded ? "timeout" : "connection_lost";
  return {
    outcome: "unknown",
    error: {
      code,
      message: code === "timeout" ? "The operation deadline elapsed before completion was proven." : "The connection was lost before completion was proven.",
    },
  };
}

function mutationResult(statusCode: { name: string; value: number; isGood(): boolean }): OpcUaMutationResult {
  const status = projectStatusCode(statusCode);
  return statusCode.isGood()
    ? { outcome: "succeeded", status }
    : { outcome: "rejected", status, error: { code: "server_rejected", message: "The OPC UA Server rejected the operation." } };
}


function nodeIdDataType(value: unknown): OpcUaDataType | string | undefined {
  const text = String(value);
  const match = /^ns=0;i=(\d+)$/.exec(text);
  return match ? dataTypeNodeIds[Number(match[1])] : boundedString(text) || undefined;
}

function dimensions(value: unknown): number[] | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const length = Array.isArray(value)
    ? value.length
    : value instanceof DataView
      ? 0
      : (value as ArrayBufferView & { length?: number }).length ?? 0;
  if (length > MAX_VARIANT_DIMENSIONS) return null;
  const values = Array.from(value as ArrayLike<unknown>);
  return values.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= MAX_VARIANT_ARRAY_LENGTH)
    ? values as number[]
    : null;
}

function variantShapeMatches(
  variant: OpcUaVariant,
  valueRank: number,
  arrayDimensions?: number[],
): boolean {
  if (!Number.isInteger(valueRank) || valueRank < -3) return false;
  const isScalar = variant.arrayType === "Scalar";
  const actualDimensions = isScalar
    ? []
    : variant.dimensions ?? (variant.arrayType === "Array"
      ? [Array.isArray(variant.value)
        ? variant.value.length
        : ArrayBuffer.isView(variant.value)
          ? (variant.value as ArrayBufferView & { length?: number }).length ?? 0
          : 0]
      : []);
  const rankMatches = valueRank === -1
    ? isScalar
    : valueRank === -2
      ? true
      : valueRank === -3
        ? isScalar || (!isScalar && actualDimensions.length === 1)
        : valueRank === 0
          ? !isScalar
          : !isScalar && valueRank > 0 && actualDimensions.length === valueRank;
  if (!rankMatches) return false;
  if (!arrayDimensions?.length) return true;
  if (actualDimensions.length !== arrayDimensions.length) return false;
  return arrayDimensions.every((expected, index) => expected === 0 || expected === actualDimensions[index]);
}

function variantMatchesArgument(variant: OpcUaVariant, argument: OpcUaMethodArgument): boolean {
  return variant.dataType === argument.dataType && variantShapeMatches(variant, argument.valueRank, argument.arrayDimensions);
}

function argumentProjection(argument: Argument): OpcUaMethodArgument {
  const result: OpcUaMethodArgument = {
    name: boundedString(argument.name ?? ""),
    dataType: nodeIdDataType(argument.dataType) ?? "",
    valueRank: argument.valueRank,
    description: projectLocalizedText(argument.description),
  };
  if (argument.arrayDimensions?.length) result.arrayDimensions = argument.arrayDimensions.slice(0, MAX_VARIANT_DIMENSIONS);
  return result;
}

function definitionEquals(left: OpcUaMethodDefinition, right: OpcUaMethodDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nodeDataType(dataType: OpcUaDataType): DataType {
  const value = DataType[dataType];
  if (typeof value !== "number") {
    throw new NodeOpcuaAdapterError("invalid_request", "The requested OPC UA data type is unsupported.");
  }
  return value;
}

function canonical64(value: TransportValue, signed: boolean): string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d*)$/.test(value) || (!signed && value.startsWith("-"))) {
    throw new NodeOpcuaAdapterError("invalid_request", "64-bit OPC UA values must be canonical decimal strings.");
  }
  const integer = BigInt(value);
  if ((signed && (integer < MIN_INT64 || integer > MAX_INT64)) || (!signed && integer > MAX_UINT64)) {
    throw new NodeOpcuaAdapterError("invalid_request", "The 64-bit OPC UA value is outside its data type range.");
  }
  return value;
}

function transportValue(value: TransportValue, dataType: DataType): unknown {
  if (Array.isArray(value)) {
    if (value.length > MAX_VARIANT_ARRAY_LENGTH) {
      throw new NodeOpcuaAdapterError("invalid_request", "The requested OPC UA array is too large.");
    }
    return value.map((item) => transportValue(item, dataType));
  }
  switch (dataType) {
    case DataType.Int64:
      return coerceInt64(canonical64(value, true));
    case DataType.UInt64:
      return coerceUInt64(canonical64(value, false));
    case DataType.ByteString:
      return typeof value === "string" ? Buffer.from(value, "base64") : value;
    case DataType.DateTime:
      return typeof value === "string" ? new Date(value) : value;
    case DataType.NodeId:
    case DataType.ExpandedNodeId:
      return typeof value === "string" ? coerceNodeId(value) : value;
    default:
      return value;
  }
}

function variantInput(value: OpcUaVariant): Variant {
  try {
    const dataType = nodeDataType(value.dataType);
    const arrayType = VariantArrayType[value.arrayType];
    if (typeof arrayType !== "number") {
      throw new NodeOpcuaAdapterError("invalid_request", "The requested OPC UA array type is unsupported.");
    }
    const variantDimensions = value.dimensions;
    if (variantDimensions && (
      variantDimensions.length > MAX_VARIANT_DIMENSIONS
      || variantDimensions.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 0 || dimension > MAX_VARIANT_ARRAY_LENGTH)
    )) {
      throw new NodeOpcuaAdapterError("invalid_request", "The requested OPC UA matrix dimensions are invalid.");
    }
    const variant = new Variant({
      dataType,
      arrayType,
      value: transportValue(value.value, dataType),
      dimensions: variantDimensions,
    });
    if (!variant.isValid()) throw new NodeOpcuaAdapterError("invalid_request", "The requested OPC UA value is invalid.");
    return variant;
  } catch (error) {
    if (error instanceof NodeOpcuaAdapterError) throw error;
    throw new NodeOpcuaAdapterError("invalid_request", "The requested OPC UA value is invalid.");
  }
}

function browseDirection(value: OpcUaBrowseRequest["direction"]): BrowseDirection {
  return value === "inverse" ? BrowseDirection.Inverse : value === "both" ? BrowseDirection.Both : BrowseDirection.Forward;
}

class NodeOpcuaSubscription implements OpcUaSubscription {
  private active = true;

  constructor(
    private readonly subscription: ClientSubscription,
    private readonly monitoredItem: ClientMonitoredItem,
    private readonly changed: (value: unknown) => void,
    private readonly removed: (subscription: NodeOpcuaSubscription) => void,
  ) {}

  async unsubscribe(): Promise<void> {
    if (!this.active) return;
    try {
      await this.subscription.terminate();
    } catch {
      throw new NodeOpcuaAdapterError("operation_failed", "The OPC UA subscription could not be terminated.");
    }
    this.active = false;
    this.monitoredItem.removeListener("changed", this.changed);
    this.removed(this);
  }
}

class NodeOpcuaSession implements OpcUaSession {
  private readonly subscriptions = new Set<NodeOpcuaSubscription>();
  private browseQueue = Promise.resolve();
  private closed = false;

  constructor(
    private readonly owner: NodeOpcuaAdapter,
    private readonly session: ClientSession,
  ) {}

  private ensureOpen(): void {
    if (this.closed) throw new NodeOpcuaAdapterError("not_connected", "The OPC UA session is closed.");
  }

  private async withBrowseLock<T>(operation: () => Promise<T>): Promise<T> {
    const previousBrowse = this.browseQueue;
    let release!: () => void;
    this.browseQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousBrowse;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async browse(request: OpcUaBrowseRequest): Promise<OpcUaBrowseResult> {
    this.ensureOpen();
    return this.withBrowseLock(() => this.browseLocked(request));
  }

  private async browseLocked(request: OpcUaBrowseRequest): Promise<OpcUaBrowseResult> {
    const maxRequests = boundedLimit(request.maxRequests, this.owner.maxBrowseRequests, MAX_BROWSE_REQUESTS) || 1;
    const maxReferencesPerNode = positiveBoundedLimit(
      request.maxReferencesPerNode,
      this.owner.maxReferencesPerNode,
      MAX_REFERENCES_PER_NODE,
    );
    const description = {
      nodeId: request.nodeId,
      browseDirection: browseDirection(request.direction),
      includeSubtypes: request.includeSubtypes ?? true,
      nodeClassMask: request.nodeClassMask ?? 0,
      resultMask: 0x3f,
      ...(request.referenceTypeId ? { referenceTypeId: request.referenceTypeId } : {}),
    };
    const previousLimit = this.session.requestedMaxReferencesPerNode;
    this.session.requestedMaxReferencesPerNode = maxReferencesPerNode;

    let requests = 0;
    let result: BrowseResult;
    let truncated = false;
    const references: OpcUaReference[] = [];
    const appendReferences = (rawReferences: typeof result.references): void => {
      const remaining = MAX_REFERENCES_PER_NODE - references.length;
      references.push(...(rawReferences ?? []).slice(0, remaining).map(projectReference));
      if ((rawReferences?.length ?? 0) > remaining) truncated = true;
    };
    try {
      result = await withDeadline(
        this.session.browse(description),
        this.owner.browseTimeout,
      );
      requests += 1;
      appendReferences(result.references);
      while (result.continuationPoint?.length && requests < maxRequests && references.length < MAX_REFERENCES_PER_NODE) {
        result = await withDeadline(
          this.session.browseNext(result.continuationPoint, false),
          this.owner.browseTimeout,
        );
        requests += 1;
        appendReferences(result.references);
      }
      if (result.continuationPoint?.length) {
        truncated = true;
        await withDeadline(this.session.browseNext(result.continuationPoint, true), this.owner.browseTimeout);
      }
      return {
        nodeId: request.nodeId,
        references,
        status: projectStatusCode(result.statusCode),
        requests,
        truncated,
      };
    } catch (error) {
      if (error instanceof NodeOpcuaAdapterError) throw error;
      throw new NodeOpcuaAdapterError("operation_failed", "The OPC UA browse operation failed.");
    } finally {
      this.session.requestedMaxReferencesPerNode = previousLimit;
    }
  }

  async read(request: OpcUaReadRequest): Promise<OpcUaReadResult>;
  async read(request: OpcUaReadRequest[]): Promise<OpcUaReadResult[]>;
  async read(request: OpcUaReadRequest | OpcUaReadRequest[]): Promise<OpcUaReadResult | OpcUaReadResult[]> {
    this.ensureOpen();
    const requests = Array.isArray(request) ? request : [request];
    let rawRequests: Array<{ nodeId: string; attributeId: number; indexRange?: NumericRange }>;
    try {
      rawRequests = requests.map((item) => ({
        nodeId: item.nodeId,
        attributeId: item.attributeId ?? VALUE_ATTRIBUTE,
        ...(item.indexRange ? { indexRange: NumericRange.coerce(item.indexRange) } : {}),
      }));
    } catch {
      throw new NodeOpcuaAdapterError("invalid_request", "The requested numeric range is invalid.");
    }
    try {
      const dataValues = await withDeadline(this.session.read(rawRequests), this.owner.readTimeout);
      const results = dataValues.map((dataValue, index) => ({
        nodeId: requests[index]!.nodeId,
        ...(requests[index]!.indexRange ? { indexRange: requests[index]!.indexRange } : {}),
        attributeId: rawRequests[index]!.attributeId,
        dataValue: projectDataValue(dataValue),
      }));
      return Array.isArray(request) ? results : results[0]!;
    } catch (error) {
      if (error instanceof NodeOpcuaAdapterError) throw error;
      throw new NodeOpcuaAdapterError("operation_failed", "The OPC UA read operation failed.");
    }
  }

  async subscribe(request: OpcUaSubscribeRequest, handler: OpcUaValueHandler): Promise<OpcUaSubscription> {
    this.ensureOpen();
    try {
      const subscription = await withDeadline(
        this.session.createSubscription2({
          requestedPublishingInterval: request.publishingInterval ?? 1_000,
          requestedLifetimeCount: 6_000,
          requestedMaxKeepAliveCount: 10,
          publishingEnabled: true,
        }),
        this.owner.readTimeout,
      );
      let monitoredItem: ClientMonitoredItem;
      try {
        monitoredItem = await withDeadline(
          subscription.monitor(
            {
              nodeId: request.nodeId,
              attributeId: request.attributeId ?? VALUE_ATTRIBUTE,
            },
            {
              samplingInterval: Math.max(0, request.samplingInterval ?? 0),
              queueSize: Math.max(1, Math.min(request.queueSize ?? 10, 1_000)),
              discardOldest: request.discardOldest ?? true,
            },
            TimestampsToReturn.Both,
          ),
          this.owner.readTimeout,
        );
      } catch (error) {
        await subscription.terminate().catch(() => undefined);
        throw error;
      }
      const changed = (dataValue: unknown) => {
        try {
          handler(projectDataValue(dataValue as Parameters<typeof projectDataValue>[0]));
        } catch {
          // The library's event emitter must not be allowed to crash the server.
        }
      };
      monitoredItem.on("changed", changed);
      const result = new NodeOpcuaSubscription(
        subscription,
        monitoredItem,
        changed,
        (terminated) => this.subscriptions.delete(terminated),
      );
      this.subscriptions.add(result);
      return result;
    } catch (error) {
      if (error instanceof NodeOpcuaAdapterError) throw error;
      throw new NodeOpcuaAdapterError("operation_failed", "The OPC UA subscription could not be created.");
    }
  }

  async write(request: OpcUaWriteRequest): Promise<OpcUaMutationResult> {
    this.ensureOpen();
    if (!request.value || typeof request.value !== "object") {
      return { outcome: "rejected", error: { code: "invalid_metadata", message: "Variable Node metadata or value is invalid." } };
    }
    if (request.attributeId !== undefined && request.attributeId !== VALUE_ATTRIBUTE) {
      return { outcome: "rejected", error: { code: "invalid_metadata", message: "Only Variable Node values may be written." } };
    }

    let metadata;
    let deadline: number;
    try {
      deadline = operationDeadline(this.owner.writeTimeout);
      metadata = await withDeadlineAt(
        this.session.read([
          { nodeId: request.nodeId, attributeId: AttributeIds.NodeClass },
          { nodeId: request.nodeId, attributeId: AttributeIds.DataType },
          { nodeId: request.nodeId, attributeId: AttributeIds.ValueRank },
          { nodeId: request.nodeId, attributeId: AttributeIds.ArrayDimensions },
          { nodeId: request.nodeId, attributeId: AttributeIds.AccessLevel },
          { nodeId: request.nodeId, attributeId: AttributeIds.UserAccessLevel },
        ]),
        deadline,
      );
    } catch {
      return {
        outcome: "rejected",
        error: { code: "invalid_metadata", message: "Variable Node metadata could not be revalidated." },
      };
    }

    if (metadata.length !== 6 || metadata.some((item) => !item.statusCode.isGood() || !item.value)) {
      return {
        outcome: "rejected",
        error: { code: "invalid_metadata", message: "Variable Node metadata could not be revalidated." },
      };
    }
    const nodeClass = metadata[0]!.value.value;
    const dataType = nodeIdDataType(metadata[1]!.value.value);
    const valueRank = Number(metadata[2]!.value.value);
    const arrayDimensions = dimensions(metadata[3]!.value.value);
    const accessLevel = Number(metadata[4]!.value.value);
    const userAccessLevel = Number(metadata[5]!.value.value);
    if (
      nodeClass !== 2
      || (accessLevel & AccessLevelFlag.CurrentWrite) === 0
      || (userAccessLevel & AccessLevelFlag.CurrentWrite) === 0
      || dataType !== request.value.dataType
      || arrayDimensions === null
      || !variantShapeMatches(request.value, valueRank, arrayDimensions)
    ) {
      return {
        outcome: "rejected",
        error: { code: "invalid_metadata", message: "Variable Node metadata does not permit this write." },
      };
    }
    let statusCode;
    try {
      const input = variantInput(request.value);
      statusCode = await withDeadlineAt(
        this.session.write({
          nodeId: request.nodeId,
          attributeId: request.attributeId ?? VALUE_ATTRIBUTE,
          value: { value: input },
        }),
        deadline,
      );
    } catch (error) {
      if (error instanceof NodeOpcuaAdapterError) {
        return { outcome: "rejected", error: { code: "invalid_metadata", message: "Variable Node metadata or value is invalid." } };
      }
      return mutationFailure(error);
    }
    return mutationResult(statusCode);
  }

  private inspectMethodAt(methodId: string, deadline: number): Promise<OpcUaMethodDefinition> {
    return this.withBrowseLock(async () => {
      try {
        const definition = await withDeadlineAt(this.session.getArgumentDefinition(methodId), deadline);
        return {
          inputArguments: definition.inputArguments.slice(0, MAX_VARIANT_ARRAY_LENGTH).map(argumentProjection),
          outputArguments: definition.outputArguments.slice(0, MAX_VARIANT_ARRAY_LENGTH).map(argumentProjection),
        };
      } catch (error) {
        if (error instanceof NodeOpcuaAdapterError) throw error;
        throw new NodeOpcuaAdapterError("operation_failed", "The Method Node metadata could not be read.");
      }
    });
  }

  async inspectMethod(methodId: string): Promise<OpcUaMethodDefinition> {
    this.ensureOpen();
    return this.inspectMethodAt(methodId, operationDeadline(this.owner.methodCallTimeout));
  }

  async call(request: OpcUaCallRequest): Promise<OpcUaCallResult> {
    this.ensureOpen();
    let definition: OpcUaMethodDefinition;
    let deadline: number;
    try {
      deadline = operationDeadline(this.owner.methodCallTimeout);
      definition = await this.inspectMethodAt(request.methodId, deadline);
      const executable = await withDeadlineAt(
        this.session.read([
          { nodeId: request.methodId, attributeId: AttributeIds.Executable },
          { nodeId: request.methodId, attributeId: AttributeIds.UserExecutable },
        ]),
        deadline,
      );
      if (
        executable.length !== 2
        || executable.some((item) => !item.statusCode.isGood() || !item.value)
        || executable.some((item) => item.value.value !== true)
      ) {
        return {
          outcome: "rejected",
          error: { code: "invalid_metadata", message: "The Method Node is not executable for this session." },
        };
      }
      if (request.expectedDefinition && !definitionEquals(definition, request.expectedDefinition)) {
        return {
          outcome: "rejected",
          error: { code: "invalid_metadata", message: "Method Node metadata changed before the Method Call." },
        };
      }
      if (definition.inputArguments.length !== request.inputArguments.length) {
        return {
          outcome: "rejected",
          error: { code: "invalid_metadata", message: "Method input arguments do not match current metadata." },
        };
      }
      for (const [index, argument] of request.inputArguments.entries()) {
        const expectedArgument = definition.inputArguments[index];
        if (!expectedArgument || !variantMatchesArgument(argument, expectedArgument)) {
          return {
            outcome: "rejected",
            error: { code: "invalid_metadata", message: "Method input argument metadata changed." },
          };
        }
      }
    } catch {
      return {
        outcome: "rejected",
        error: { code: "invalid_metadata", message: "Method Node metadata is invalid." },
      };
    }

    let inputArguments: Variant[];
    try {
      inputArguments = request.inputArguments.map(variantInput);
    } catch {
      return {
        outcome: "rejected",
        error: { code: "invalid_metadata", message: "Method input arguments are invalid." },
      };
    }

    try {
      const result = await withDeadlineAt(
        this.session.call({
          objectId: request.objectId,
          methodId: request.methodId,
          inputArguments,
        }),
        deadline,
      );
      return {
        ...mutationResult(result.statusCode),
        outputArguments: result.outputArguments?.map(projectVariant),
      };
    } catch (error) {
      return mutationFailure(error);
    }
  }

  async closeRaw(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.subscriptions].map((subscription) => subscription.unsubscribe().catch(() => undefined)));
    this.subscriptions.clear();
    await this.session.close(true).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.owner.disconnect();
  }
}

class NodeOpcuaAdapter implements OpcUaClient {
  private rawClient?: RawOpcuaClient;
  private session?: NodeOpcuaSession;
  private readonly listeners = new Set<(event: OpcUaConnectionLoss) => void>();

  readonly maxBrowseRequests: number;
  readonly maxReferencesPerNode: number;
  readonly discoveryTimeout: number;
  readonly connectTimeout: number;
  readonly browseTimeout: number;
  readonly readTimeout: number;
  readonly writeTimeout: number;
  readonly methodCallTimeout: number;

  constructor(private readonly options: NodeOpcuaAdapterOptions) {
    this.maxBrowseRequests = boundedLimit(options.maxBrowseRequests, DEFAULT_MAX_BROWSE_REQUESTS, MAX_BROWSE_REQUESTS) || 1;
    this.maxReferencesPerNode = positiveBoundedLimit(
      options.maxReferencesPerNode,
      DEFAULT_MAX_REFERENCES_PER_NODE,
      MAX_REFERENCES_PER_NODE,
    );
    this.discoveryTimeout = timeout(options, "discoveryTimeout", DEFAULT_TIMEOUT);
    this.connectTimeout = timeout(options, "connectTimeout", DEFAULT_TIMEOUT);
    this.browseTimeout = timeout(options, "browseTimeout", DEFAULT_TIMEOUT);
    this.readTimeout = timeout(options, "readTimeout", DEFAULT_TIMEOUT);
    this.writeTimeout = timeout(options, "writeTimeout", DEFAULT_TIMEOUT);
    this.methodCallTimeout = timeout(options, "methodCallTimeout", DEFAULT_METHOD_TIMEOUT);
  }

  onConnectionLost(listener: (event: OpcUaConnectionLoss) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async discover(request: OpcUaDiscoveryRequest): Promise<OpcUaDiscoveryResult> {
    const result = await this.discoverRaw(request.endpointUrl);
    return {
      servers: result.servers.map((server) => ({
        applicationUri: boundedString(server.applicationUri ?? ""),
        productUri: boundedString(server.productUri ?? ""),
        applicationName: server.applicationName ? projectLocalizedText(server.applicationName) : undefined,
        discoveryUrls: (server.discoveryUrls ?? [])
          .filter((url): url is string => typeof url === "string")
          .slice(0, 32)
          .map(boundedString),
      })),
      endpoints: result.endpoints.map(endpointProjection),
    };
  }

  async connect(request: OpcUaConnectRequest): Promise<OpcUaSession> {
    if (this.rawClient || this.session) {
      throw new NodeOpcuaAdapterError("invalid_request", "An OPC UA session is already connected.");
    }
    const discovered = await this.discoverRaw(request.endpointUrl);
    const mode = request.securityMode ?? "None";
    const policy = request.securityPolicyUri ?? SecurityPolicy.None;
    const selectedRaw = discovered.endpoints.find(
      (endpoint) => endpoint.endpointUrl === request.endpointUrl && endpoint.securityMode === securityMode(mode) && endpoint.securityPolicyUri === policy,
    );
    if (!selectedRaw) throw new NodeOpcuaAdapterError("endpoint_not_found", "The requested OPC UA endpoint was not advertised.");
    const selected = endpointProjection(selectedRaw);
    if (mode !== "None" && !selectedRaw.serverCertificate) {
      throw new NodeOpcuaAdapterError("server_certificate_required", "The secure OPC UA endpoint did not provide a server certificate.");
    }
    if (mode !== "None" && !request.serverCertificateFingerprint) {
      throw new NodeOpcuaAdapterError("server_certificate_required", "A trusted server certificate fingerprint is required for a secure connection.");
    }
    if (mode !== "None" && selected.serverCertificateFingerprint !== request.serverCertificateFingerprint?.toLowerCase()) {
      throw new NodeOpcuaAdapterError("connection_failed", "The OPC UA Server certificate fingerprint did not match the trusted fingerprint.");
    }

    const rawClient = this.createRawClient({
      securityMode: securityMode(mode),
      securityPolicy: securityPolicy(policy),
      endpointMustExist: true,
      ...(selectedRaw?.serverCertificate ? { serverCertificate: selectedRaw.serverCertificate } : {}),
    });
    let lossNotified = false;
    const notifyLoss = (event: OpcUaConnectionLoss) => {
      if (lossNotified) return;
      lossNotified = true;
      this.notifyConnectionLoss(event);
    };
    try {
      rawClient.on("connection_lost", () => notifyLoss({ code: "connection_lost", message: "The OPC UA connection was lost." }));
      rawClient.on("close", () => {
        if (this.rawClient === rawClient && this.session) {
          notifyLoss({ code: "session_closed", message: "The OPC UA connection was closed." });
        }
      });
      await withDeadline(rawClient.connect(selected.endpointUrl), this.connectTimeout);
      const rawSession = await withDeadline(
        rawClient.createSession(request.userIdentity ? this.userIdentity(request.userIdentity) : { type: UserTokenType.Anonymous }),
        this.connectTimeout,
      );
      this.rawClient = rawClient;
      const session = new NodeOpcuaSession(this, rawSession);
      this.session = session;
      return session;
    } catch {
      await rawClient.disconnect().catch(() => undefined);
      throw new NodeOpcuaAdapterError("connection_failed", "The OPC UA connection could not be established.");
    }
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    const client = this.rawClient;
    this.session = undefined;
    this.rawClient = undefined;
    await session?.closeRaw();
    await client?.disconnect().catch(() => undefined);
  }

  private notifyConnectionLoss(event: OpcUaConnectionLoss): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Application event sinks must not affect transport cleanup.
      }
    }
  }

  private createRawClient(overrides: Partial<RawOpcuaClientOptions>): RawOpcuaClient {
    const clientOptions: RawOpcuaClientOptions = {
      applicationName: this.options.applicationName,
      applicationUri: this.options.applicationUri,
      connectionStrategy: { maxRetry: 0 },
      defaultTransactionTimeout: this.options.defaultTransactionTimeout,
      certificateFile: this.options.certificateFile,
      privateKeyFile: this.options.privateKeyFile,
      clientCertificateManager: this.options.clientCertificateManager as RawOpcuaClientOptions["clientCertificateManager"],
      ...overrides,
    };
    return OPCUAClient.create(clientOptions);
  }

  private async discoverRaw(endpointUrl: string): Promise<{
    servers: ApplicationDescription[];
    endpoints: EndpointDescription[];
  }> {
    const client = this.createRawClient({
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      endpointMustExist: false,
    });
    try {
      await withDeadline(client.connect(endpointUrl), this.discoveryTimeout);
      const [servers, endpoints] = await Promise.all([
        withDeadline(client.findServers(), this.discoveryTimeout),
        withDeadline(client.getEndpoints({ endpointUrl }), this.discoveryTimeout),
      ]);
      return { servers, endpoints };
    } catch {
      throw new NodeOpcuaAdapterError("discovery_failed", "OPC UA endpoint discovery failed.");
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }

  private userIdentity(identity: NonNullable<OpcUaConnectRequest["userIdentity"]>): UserIdentityInfo {
    if (identity.type === "anonymous") return { type: UserTokenType.Anonymous };
    return { type: UserTokenType.UserName, userName: identity.username, password: identity.password };
  }
}

export function createNodeOpcuaAdapter(options: NodeOpcuaAdapterOptions): OpcUaClient {
  return new NodeOpcuaAdapter(options);
}

