export interface Clock {
  now(): Date;
}

export interface EventSink<Event> {
  publish(event: Event): void;
}

export interface ApplicationDependencies<Event = ApplicationEvent> {
  clock: Clock;
  events: EventSink<Event>;
  clientFactory: OpcUaClientFactory;
  savedConnections: SavedConnectionStore;
  timers?: TimerScheduler;
  logger?: Logger;
  config?: ApplicationConfig;
}

export type TransportValue =
  | null
  | boolean
  | number
  | string
  | TransportValue[]
  | { [key: string]: TransportValue };

export type OpcUaDataType =
  | "Null"
  | "Boolean"
  | "SByte"
  | "Byte"
  | "Int16"
  | "UInt16"
  | "Int32"
  | "UInt32"
  | "Int64"
  | "UInt64"
  | "Float"
  | "Double"
  | "String"
  | "DateTime"
  | "Guid"
  | "ByteString"
  | "XmlElement"
  | "NodeId"
  | "ExpandedNodeId"
  | "StatusCode"
  | "QualifiedName"
  | "LocalizedText"
  | "ExtensionObject"
  | "DataValue"
  | "Variant"
  | "DiagnosticInfo";

export type OpcUaVariantArrayType = "Scalar" | "Array" | "Matrix";

export interface OpcUaVariant {
  dataType: OpcUaDataType;
  arrayType: OpcUaVariantArrayType;
  value: TransportValue;
  dimensions?: number[];
}

export interface OpcUaStatusCode {
  name: string;
  value: number;
  description?: string;
}

export interface OpcUaDataValue {
  status: OpcUaStatusCode;
  sourceTimestamp?: string;
  serverTimestamp?: string;
  sourcePicoseconds?: number;
  serverPicoseconds?: number;
  value?: OpcUaVariant;
}

export interface OpcUaLocalizedText {
  locale?: string;
  text?: string;
}

export interface OpcUaQualifiedName {
  namespaceIndex: number;
  name?: string;
}

export type OpcUaNodeClass =
  | "Object"
  | "Variable"
  | "Method"
  | "ObjectType"
  | "VariableType"
  | "ReferenceType"
  | "DataType"
  | "View"
  | "Unspecified";

export interface OpcUaReference {
  nodeId: string;
  browseName: OpcUaQualifiedName;
  displayName: OpcUaLocalizedText;
  nodeClass: OpcUaNodeClass;
  referenceTypeId?: string;
  typeDefinition?: string;
  isForward: boolean;
}

export interface OpcUaBrowseRequest {
  nodeId: string;
  direction?: "forward" | "inverse" | "both";
  referenceTypeId?: string;
  includeSubtypes?: boolean;
  nodeClassMask?: number;
  maxReferencesPerNode?: number;
  maxRequests?: number;
}

export interface OpcUaBrowseResult {
  nodeId: string;
  references: OpcUaReference[];
  status: OpcUaStatusCode;
  requests: number;
  truncated: boolean;
}

export interface OpcUaReadRequest {
  nodeId: string;
  attributeId?: number;
  indexRange?: string;
}

export interface OpcUaReadResult extends OpcUaReadRequest {
  attributeId: number;
  dataValue: OpcUaDataValue;
}

export interface OpcUaSubscribeRequest {
  nodeId: string;
  attributeId?: number;
  samplingInterval?: number;
  queueSize?: number;
  discardOldest?: boolean;
  publishingInterval?: number;
}

export interface OpcUaConnectionLoss {
  message: string;
  code: "connection_lost" | "session_closed";
}

export type OpcUaValueHandler = (value: OpcUaDataValue) => void;

export interface OpcUaSubscription {
  unsubscribe(): Promise<void>;
}

export interface OpcUaWriteRequest {
  nodeId: string;
  value: OpcUaVariant;
  attributeId?: number;
}

export type OpcUaMutationOutcome = "succeeded" | "rejected" | "unknown";

export interface OpcUaMutationResult {
  outcome: OpcUaMutationOutcome;
  status?: OpcUaStatusCode;
  error?: {
    code: "timeout" | "connection_lost" | "invalid_metadata" | "server_rejected";
    message: string;
  };
}

export interface OpcUaMethodArgument {
  name: string;
  dataType: string;
  valueRank: number;
  arrayDimensions?: number[];
  description: OpcUaLocalizedText;
}

export interface OpcUaMethodDefinition {
  inputArguments: OpcUaMethodArgument[];
  outputArguments: OpcUaMethodArgument[];
}

export interface OpcUaCallRequest {
  objectId: string;
  methodId: string;
  inputArguments: OpcUaVariant[];
  expectedDefinition?: OpcUaMethodDefinition;
}

export interface OpcUaCallResult extends OpcUaMutationResult {
  outputArguments?: OpcUaVariant[];
}

export interface OpcUaSession {
  browse(request: OpcUaBrowseRequest): Promise<OpcUaBrowseResult>;
  read(request: OpcUaReadRequest): Promise<OpcUaReadResult>;
  read(request: OpcUaReadRequest[]): Promise<OpcUaReadResult[]>;
  subscribe(request: OpcUaSubscribeRequest, handler: OpcUaValueHandler): Promise<OpcUaSubscription>;
  write(request: OpcUaWriteRequest): Promise<OpcUaMutationResult>;
  inspectMethod(methodId: string): Promise<OpcUaMethodDefinition>;
  call(request: OpcUaCallRequest): Promise<OpcUaCallResult>;
  close(): Promise<void>;
}

export interface OpcUaEndpoint {
  endpointUrl: string;
  securityMode: "None" | "Sign" | "SignAndEncrypt";
  securityPolicyUri: string;
  serverCertificateFingerprint?: string;
}

export interface OpcUaServerDescription {
  applicationUri: string;
  productUri: string;
  applicationName?: OpcUaLocalizedText;
  discoveryUrls: string[];
}

export interface OpcUaDiscoveryResult {
  servers: OpcUaServerDescription[];
  endpoints: OpcUaEndpoint[];
}

export interface OpcUaDiscoveryRequest {
  endpointUrl: string;
}

export interface OpcUaConnectRequest {
  endpointUrl: string;
  securityMode?: "None" | "Sign" | "SignAndEncrypt";
  securityPolicyUri?: string;
  serverCertificateFingerprint?: string;
  userIdentity?:
    | { type: "anonymous" }
    | { type: "username"; username: string; password: string };
}

export interface OpcUaClient {
  discover(request: OpcUaDiscoveryRequest): Promise<OpcUaDiscoveryResult>;
  connect(request: OpcUaConnectRequest): Promise<OpcUaSession>;
  onConnectionLost(listener: (event: OpcUaConnectionLoss) => void): () => void;
  disconnect(): Promise<void>;
}

export interface OpcUaClientOptions {
  applicationName: string;
  applicationUri: string;
  certificateFile?: string;
  privateKeyFile?: string;
  defaultTransactionTimeout?: number;
  discoveryTimeout?: number;
  connectTimeout?: number;
  browseTimeout?: number;
  readTimeout?: number;
  writeTimeout?: number;
  methodCallTimeout?: number;
  maxBrowseRequests?: number;
  maxReferencesPerNode?: number;
}

export type OpcUaClientFactory = (options: OpcUaClientOptions) => OpcUaClient;

export interface TimerScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface SavedConnection {
  id: string;
  name: string;
  endpoint: string;
  securityPolicy: string;
  securityMode: "None" | "Sign" | "SignAndEncrypt";
  username?: string;
  clientCertificateReference?: string;
  serverCertificatePin?: string;
}

export interface SavedConnectionStore {
  list(): Promise<SavedConnection[]>;
  save(connection: SavedConnection): Promise<void>;
  remove?(id: string): Promise<void>;
}

export interface ApplicationConfig {
  deadlines?: Partial<Pick<OpcUaClientOptions, "discoveryTimeout" | "connectTimeout" | "browseTimeout" | "readTimeout" | "writeTimeout" | "methodCallTimeout">>;
  maxSafeReadConcurrency?: number;
  shallowBrowseIntervalMilliseconds?: number;
  shallowBrowseRequestBudget?: number;
  watchlistLimit?: number;
  trendPointLimit?: number;
}

export interface ConnectionSnapshot {
  state: "disconnected" | "connecting" | "connected" | "connection-lost";
  endpointUrl?: string;
  connectionGeneration: number;
  error?: string;
}

export interface SafetySnapshot {
  readOnly: boolean;
  safetyGeneration: number;
}

export interface VariableNodeMetadata {
  nodeId: string;
  browseName?: OpcUaQualifiedName;
  displayName?: OpcUaLocalizedText;
  dataType?: OpcUaDataType;
  valueRank?: number;
  arrayDimensions?: number[];
  engineeringUnit?: string;
  range?: { low?: number; high?: number };
}

export interface VariableNodeInspection {
  nodeId: string;
  metadata?: VariableNodeMetadata;
  value?: OpcUaDataValue;
  stale: boolean;
  outOfRange: boolean;
  updatedAt?: string;
}

export interface TrendPoint {
  timestamp: string;
  value: TransportValue;
  status: OpcUaStatusCode;
}

export interface SearchCandidate {
  nodeId: string;
  aliasNames?: string[];
  browseName?: string;
  displayName?: string;
  explicitBrowse?: boolean;
  distance?: number;
  nodeClass?: OpcUaNodeClass;
}

export interface SearchResult extends SearchCandidate {
  score: number;
  match: "alias-exact" | "browse-exact" | "display-exact" | "prefix" | "substring";
}

export interface SearchSnapshot {
  results: SearchResult[];
  coverage: "complete" | "incomplete";
  requests: number;
  budget: number;
}

export interface ApplicationSnapshot {
  connection: ConnectionSnapshot;
  safety: SafetySnapshot;
  watchlist: string[];
  inspections: Record<string, VariableNodeInspection>;
  trends: Record<string, TrendPoint[]>;
  search: SearchSnapshot;
}

type ApplicationEventType =
  | "connection-changed"
  | "safety-changed"
  | "inspection-changed"
  | "watchlist-changed"
  | "trend-changed"
  | "search-changed";

export interface ApplicationEvent {
  type: ApplicationEventType;
  at: string;
  snapshot: ApplicationSnapshot;
}

export class ApplicationError extends Error {
  public constructor(
    public readonly code:
      | "confirmation_required"
      | "connection_required"
      | "mutation_not_allowed"
      | "watchlist_limit_reached"
      | "browse_budget_exhausted"
      | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export interface ApplicationFacade {
  snapshot(): ApplicationSnapshot;
  listSavedConnections(): Promise<SavedConnection[]>;
  saveSavedConnection(connection: SavedConnection): Promise<void>;
  removeSavedConnection(id: string): Promise<void>;
  discover(request: OpcUaDiscoveryRequest): Promise<OpcUaDiscoveryResult>;
  connect(request: OpcUaConnectRequest): Promise<void>;
  disconnect(): Promise<void>;
  setReadOnly(readOnly: boolean, confirmation?: boolean | string): Promise<void>;
  browse(request: OpcUaBrowseRequest): Promise<OpcUaBrowseResult>;
  read(request: OpcUaReadRequest | OpcUaReadRequest[]): Promise<OpcUaReadResult | OpcUaReadResult[]>;
  search(query: string, candidates?: SearchCandidate[]): Promise<SearchSnapshot>;
  inspectVariable(nodeId: string, metadata?: VariableNodeMetadata): Promise<VariableNodeInspection>;
  addToWatchlist(nodeId: string): Promise<void>;
  removeFromWatchlist(nodeId: string): Promise<void>;
  subscribe(nodeId: string): Promise<void>;
  unsubscribe(nodeId: string): Promise<void>;
  getTrend(nodeId: string): TrendPoint[];
  inspectMethod(methodId: string): Promise<OpcUaMethodDefinition>;
  close(): Promise<void>;
}

const DEFAULT_CONFIG: Required<ApplicationConfig> = {
  deadlines: {
    discoveryTimeout: 15_000,
    connectTimeout: 15_000,
    browseTimeout: 15_000,
    readTimeout: 15_000,
    writeTimeout: 15_000,
    methodCallTimeout: 30_000,
  },
  maxSafeReadConcurrency: 4,
  shallowBrowseIntervalMilliseconds: 1_000,
  shallowBrowseRequestBudget: 250,
  watchlistLimit: 100,
  trendPointLimit: 500,
};

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value as Readonly<T>;
}

function safeConnection(connection: SavedConnection, logger?: Logger): SavedConnection {
  const certificateReference = connection.clientCertificateReference;
  const safeReference = certificateReference === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(certificateReference)
    ? certificateReference
    : undefined;
  if (certificateReference !== undefined && safeReference === undefined) logger?.warn?.("Ignored invalid client certificate reference.", { code: "invalid_certificate_reference" });
  return {
    id: connection.id,
    name: connection.name,
    endpoint: connection.endpoint,
    securityPolicy: connection.securityPolicy,
    securityMode: connection.securityMode,
    ...(connection.username === undefined ? {} : { username: connection.username }),
    ...(safeReference === undefined ? {} : { clientCertificateReference: safeReference }),
    ...(connection.serverCertificatePin === undefined ? {} : { serverCertificatePin: connection.serverCertificatePin }),
  };
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function candidateMatch(candidate: SearchCandidate, query: string): { match: SearchResult["match"]; rank: number } | undefined {
  const needle = normalizedText(query);
  if (!needle) return undefined;
  const aliases = (candidate.aliasNames ?? []).map(normalizedText);
  const browse = normalizedText(candidate.browseName);
  const display = normalizedText(candidate.displayName);
  if (aliases.includes(needle)) return { match: "alias-exact", rank: 0 };
  if (browse === needle) return { match: "browse-exact", rank: 1 };
  if (display === needle) return { match: "display-exact", rank: 2 };
  if (aliases.some((value) => value.startsWith(needle)) || browse.startsWith(needle) || display.startsWith(needle)) return { match: "prefix", rank: 3 };
  if (aliases.some((value) => value.includes(needle)) || browse.includes(needle) || display.includes(needle)) return { match: "substring", rank: 4 };
  return undefined;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function rankSearch(candidates: SearchCandidate[], query: string): SearchResult[] {
  return candidates
    .map((candidate) => {
      const matched = candidateMatch(candidate, query);
      if (!matched) return undefined;
      return { ...candidate, match: matched.match, score: matched.rank };
    })
    .filter((candidate): candidate is SearchResult => candidate !== undefined)
    .sort((left, right) => {
      const explicit = (left.explicitBrowse === true ? 0 : 1) - (right.explicitBrowse === true ? 0 : 1);
      const match = left.score - right.score;
      const distance = (left.distance ?? Number.MAX_SAFE_INTEGER) - (right.distance ?? Number.MAX_SAFE_INTEGER);
      return explicit || match || distance || compareCodePoints(left.nodeId, right.nodeId);
    });
}

function valueAsNumber(value: OpcUaVariant | undefined): number | undefined {
  if (!value || value.arrayType !== "Scalar" || typeof value.value !== "number" || !Number.isFinite(value.value)) return undefined;
  return value.value;
}

export function createApplication(dependencies: ApplicationDependencies): ApplicationFacade {
  const config = {
    ...DEFAULT_CONFIG,
    ...dependencies.config,
    deadlines: { ...DEFAULT_CONFIG.deadlines, ...dependencies.config?.deadlines },
  };
  if (!Number.isInteger(config.maxSafeReadConcurrency) || config.maxSafeReadConcurrency < 1) {
    throw new ApplicationError("invalid_request", "Safe-read concurrency must be a positive integer.");
  }
  if (!Number.isInteger(config.shallowBrowseIntervalMilliseconds) || config.shallowBrowseIntervalMilliseconds < 1) {
    throw new ApplicationError("invalid_request", "The shallow browse interval must be a positive integer.");
  }
  if (!Number.isInteger(config.shallowBrowseRequestBudget) || config.shallowBrowseRequestBudget < 1 || config.shallowBrowseRequestBudget > 250) {
    throw new ApplicationError("invalid_request", "The shallow browse request budget must be between 1 and 250.");
  }
  if (!Number.isInteger(config.watchlistLimit) || config.watchlistLimit < 1 || config.watchlistLimit > 100) {
    throw new ApplicationError("invalid_request", "The Watchlist limit must be between 1 and 100.");
  }
  if (!Number.isInteger(config.trendPointLimit) || config.trendPointLimit < 1 || config.trendPointLimit > 500) {
    throw new ApplicationError("invalid_request", "The Session Trend limit must be between 1 and 500.");
  }
  const timers = dependencies.timers ?? {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const client = dependencies.clientFactory({
    applicationName: "OPC UA Studio",
    applicationUri: "urn:ostudio-web",
    ...config.deadlines,
  });
  let session: OpcUaSession | undefined;
  let unsubscribeConnectionLoss: (() => void) | undefined;
  let state: ApplicationSnapshot = freeze({
    connection: { state: "disconnected", connectionGeneration: 0 },
    safety: { readOnly: true, safetyGeneration: 1 },
    watchlist: [],
    inspections: {},
    trends: {},
    search: { results: [], coverage: "complete", requests: 0, budget: config.shallowBrowseRequestBudget },
  });
  let transition = Promise.resolve();
  const indexed = new Map<string, SearchCandidate>();
  const subscriptions = new Map<string, OpcUaSubscription>();
  const trendPoints = new Map<string, TrendPoint[]>();
  let browseRequests = 0;
  let shallowBrowseTimer: unknown;
  let shallowBrowseTimerResolve: (() => void) | undefined;
  let shallowBrowseTransition = Promise.resolve();
  let lastShallowBrowseAt: number | undefined;
  let activeSafeReads = 0;
  const waitingSafeReads: Array<() => void> = [];
  const safeRead = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (activeSafeReads >= config.maxSafeReadConcurrency) await new Promise<void>((resolve) => waitingSafeReads.push(resolve));
    activeSafeReads += 1;
    try {
      return await operation();
    } finally {
      activeSafeReads -= 1;
      waitingSafeReads.shift()?.();
    }
  };

  const publish = (type: ApplicationEventType): void => {
    const snapshot = state;
    dependencies.events.publish({ type, at: dependencies.clock.now().toISOString(), snapshot } as ApplicationEvent);
  };
  const update = (change: (current: ApplicationSnapshot) => ApplicationSnapshot, type: ApplicationEventType): void => {
    state = freeze(change(state));
    publish(type);
  };
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = transition.then(operation, operation);
    transition = result.then(() => undefined, () => undefined);
    return result;
  };
  const requireSession = (): OpcUaSession => {
    if (!session) throw new ApplicationError("connection_required", "An OPC UA connection is required.");
    return session;
  };
  const markSafety = (readOnly: boolean): void => {
    update((current) => ({ ...current, safety: { readOnly, safetyGeneration: current.safety.safetyGeneration + 1 } }), "safety-changed");
  };
  const resetSessionState = (): void => {
    indexed.clear();
    subscriptions.clear();
    trendPoints.clear();
    browseRequests = 0;
    lastShallowBrowseAt = undefined;
    if (shallowBrowseTimer !== undefined) timers.clearTimeout(shallowBrowseTimer);
    shallowBrowseTimer = undefined;
    shallowBrowseTimerResolve?.();
    shallowBrowseTimerResolve = undefined;
    update((current) => ({
      ...current,
      watchlist: [],
      inspections: {},
      trends: {},
      search: { results: [], coverage: "complete", requests: 0, budget: config.shallowBrowseRequestBudget },
    }), "search-changed");
  };

  const connectionLost = (generation: number, lostSession: OpcUaSession): void => {
    if (state.connection.connectionGeneration !== generation || session !== lostSession) return;
    void serialized(async () => {
      if (state.connection.connectionGeneration !== generation || session !== lostSession) return;
      session = undefined;
      unsubscribeConnectionLoss?.();
      unsubscribeConnectionLoss = undefined;
      for (const subscription of subscriptions.values()) await subscription.unsubscribe().catch(() => undefined);
      subscriptions.clear();
      update((current) => ({
        ...current,
        connection: { ...current.connection, state: "connection-lost", error: "The OPC UA connection was lost." },
        inspections: Object.fromEntries(Object.entries(current.inspections).map(([nodeId, inspection]) => [nodeId, { ...inspection, stale: true }])),
      }), "connection-changed");
      markSafety(true);
    });
  };

  const shallowBrowse = async (): Promise<void> => {
    if (!session || browseRequests >= config.shallowBrowseRequestBudget) {
      update((current) => ({ ...current, search: { ...current.search, coverage: "incomplete" } }), "search-changed");
      return;
    }
    const now = dependencies.clock.now().getTime();
    if (lastShallowBrowseAt !== undefined && now - lastShallowBrowseAt < config.shallowBrowseIntervalMilliseconds) return;
    browseRequests += 1;
    const currentSession = session;
    update((current) => ({ ...current, search: { ...current.search, requests: browseRequests, coverage: "incomplete" } }), "search-changed");
    const result = await currentSession.browse({ nodeId: "i=85", maxRequests: 1 });
    lastShallowBrowseAt = dependencies.clock.now().getTime();
    for (const reference of result.references) {
      indexed.set(reference.nodeId, {
        nodeId: reference.nodeId,
        browseName: reference.browseName.name,
        displayName: reference.displayName.text,
        explicitBrowse: false,
      });
    }
    update((current) => ({ ...current, search: { ...current.search, requests: browseRequests, coverage: "incomplete" } }), "search-changed");
  };

  const serializedShallowBrowse = (): Promise<void> => {
    const result = shallowBrowseTransition.then(shallowBrowse, shallowBrowse);
    shallowBrowseTransition = result.then(() => undefined, () => undefined);
    return result;
  };

  const facade: ApplicationFacade = {
    snapshot: () => state,
    listSavedConnections: async () => (await dependencies.savedConnections.list()).map((connection) => safeConnection(connection, dependencies.logger)),
    saveSavedConnection: async (connection) => dependencies.savedConnections.save(safeConnection(connection, dependencies.logger)),
    removeSavedConnection: async (id) => dependencies.savedConnections.remove?.(id),
    discover: (request) => client.discover(request),
    connect: (request) => serialized(async () => {
      if (session) throw new ApplicationError("invalid_request", "An OPC UA session is already connected.");
      update((current) => ({ ...current, connection: { ...current.connection, state: "connecting", endpointUrl: request.endpointUrl } }), "connection-changed");
      try {
        session = await client.connect(request);
        resetSessionState();
        const generation = state.connection.connectionGeneration + 1;
        const connectedSession = session;
        unsubscribeConnectionLoss?.();
        unsubscribeConnectionLoss = client.onConnectionLost(() => connectionLost(generation, connectedSession));
        update((current) => ({ ...current, connection: { state: "connected", endpointUrl: request.endpointUrl, connectionGeneration: generation } }), "connection-changed");
        markSafety(true);
      } catch (error) {
        dependencies.logger?.error?.("OPC UA connection failed.", { code: "connection_failed" });
        update((current) => ({ ...current, connection: { ...current.connection, state: "disconnected", error: "Connection failed." } }), "connection-changed");
        throw error;
      }
    }),
    disconnect: () => serialized(async () => {
      session = undefined;
      unsubscribeConnectionLoss?.();
      unsubscribeConnectionLoss = undefined;
      for (const subscription of subscriptions.values()) await subscription.unsubscribe().catch(() => undefined);
      await client.disconnect();
      resetSessionState();
      update((current) => ({ ...current, connection: { state: "disconnected", connectionGeneration: current.connection.connectionGeneration } }), "connection-changed");
      markSafety(true);
    }),
    setReadOnly: (readOnly, confirmation) => serialized(async () => {
      if (!readOnly && confirmation !== true && confirmation !== "DISABLE_READ_ONLY") throw new ApplicationError("confirmation_required", "Disabling Read-Only Mode requires confirmation.");
      if (!readOnly && !session) throw new ApplicationError("connection_required", "An OPC UA connection is required.");
      if (state.safety.readOnly !== readOnly) markSafety(readOnly);
    }),
    browse: (request) => serialized(async () => {
      const result = await requireSession().browse(request);
      for (const reference of result.references) {
        indexed.set(reference.nodeId, { nodeId: reference.nodeId, browseName: reference.browseName.name, displayName: reference.displayName.text, explicitBrowse: true });
      }
      return result;
    }),
    read: async (request): Promise<OpcUaReadResult | OpcUaReadResult[]> => safeRead<OpcUaReadResult | OpcUaReadResult[]>(() => Array.isArray(request) ? requireSession().read(request) : requireSession().read(request)),
    search: async (query, candidates = []) => {
      for (const candidate of candidates) indexed.set(candidate.nodeId, { ...candidate, explicitBrowse: candidate.explicitBrowse ?? true });
      const results = rankSearch([...indexed.values()], query);
      const incompleteCoverage = state.search.coverage === "incomplete" || [...indexed.values()].some((candidate) => candidate.explicitBrowse !== true);
      if (!results.length && session && browseRequests < config.shallowBrowseRequestBudget) {
        const elapsed = lastShallowBrowseAt === undefined ? config.shallowBrowseIntervalMilliseconds : dependencies.clock.now().getTime() - lastShallowBrowseAt;
        if (elapsed >= config.shallowBrowseIntervalMilliseconds) {
          await serializedShallowBrowse();
        } else if (shallowBrowseTimer === undefined) {
          await new Promise<void>((resolve) => {
            shallowBrowseTimerResolve = resolve;
            shallowBrowseTimer = timers.setTimeout(() => {
              shallowBrowseTimer = undefined;
              shallowBrowseTimerResolve = undefined;
              void serializedShallowBrowse().finally(resolve);
            }, config.shallowBrowseIntervalMilliseconds - Math.max(0, elapsed));
          });
        }
      }
      const search = { ...state.search, results: rankSearch([...indexed.values()], query), coverage: incompleteCoverage ? "incomplete" as const : state.search.coverage, requests: browseRequests };
      update((current) => ({ ...current, search }), "search-changed");
      return search;
    },
    inspectVariable: async (nodeId, metadata) => {
      const result = await safeRead(() => requireSession().read({ nodeId }));
      const value = result.dataValue;
      const numeric = valueAsNumber(value.value);
      const range = metadata?.range;
      const outOfRange = numeric !== undefined && ((range?.low !== undefined && numeric < range.low) || (range?.high !== undefined && numeric > range.high));
      const inspection: VariableNodeInspection = { nodeId, metadata, value, stale: false, outOfRange, updatedAt: dependencies.clock.now().toISOString() };
      update((current) => ({ ...current, inspections: { ...current.inspections, [nodeId]: inspection } }), "inspection-changed");
      return inspection;
    },
    addToWatchlist: async (nodeId) => {
      if (state.watchlist.includes(nodeId)) return;
      if (state.watchlist.length >= config.watchlistLimit) throw new ApplicationError("watchlist_limit_reached", "The Watchlist limit has been reached.");
      update((current) => ({ ...current, watchlist: [...current.watchlist, nodeId] }), "watchlist-changed");
    },
    removeFromWatchlist: async (nodeId) => update((current) => ({ ...current, watchlist: current.watchlist.filter((item) => item !== nodeId) }), "watchlist-changed"),
    subscribe: async (nodeId) => {
      if (subscriptions.has(nodeId)) return;
      const subscription = await requireSession().subscribe({ nodeId }, (value) => {
        const timestamp = value.sourceTimestamp ?? value.serverTimestamp ?? dependencies.clock.now().toISOString();
        const point: TrendPoint = { timestamp, value: value.value?.value ?? null, status: value.status };
        const points = [...(trendPoints.get(nodeId) ?? []), point].slice(-config.trendPointLimit);
        trendPoints.set(nodeId, points);
        update((current) => {
          const previous = current.inspections[nodeId];
          const numeric = valueAsNumber(value.value);
          const range = previous?.metadata?.range;
          const outOfRange = numeric !== undefined && ((range?.low !== undefined && numeric < range.low) || (range?.high !== undefined && numeric > range.high));
          return {
            ...current,
            inspections: previous ? { ...current.inspections, [nodeId]: { ...previous, value, stale: false, outOfRange, updatedAt: timestamp } } : current.inspections,
            trends: { ...current.trends, [nodeId]: points },
          };
        }, "trend-changed");
      });
      subscriptions.set(nodeId, subscription);
    },
    unsubscribe: async (nodeId) => {
      const subscription = subscriptions.get(nodeId);
      subscriptions.delete(nodeId);
      await subscription?.unsubscribe();
    },
    getTrend: (nodeId) => [...(trendPoints.get(nodeId) ?? [])],
    inspectMethod: (methodId) => requireSession().inspectMethod(methodId),
    close: () => serialized(async () => {
      if (shallowBrowseTimer !== undefined) timers.clearTimeout(shallowBrowseTimer);
      shallowBrowseTimer = undefined;
      shallowBrowseTimerResolve?.();
      shallowBrowseTimerResolve = undefined;
      unsubscribeConnectionLoss?.();
      unsubscribeConnectionLoss = undefined;
      session = undefined;
      for (const subscription of subscriptions.values()) await subscription.unsubscribe().catch(() => undefined);
      await client.disconnect();
      resetSessionState();
      markSafety(true);
    }),
  };
  return facade;
}
