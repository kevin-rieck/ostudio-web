export interface Clock {
  now(): Date;
}

export interface EventSink<Event> {
  publish(event: Event): void;
}

export interface ApplicationDependencies<Event> {
  clock: Clock;
  events: EventSink<Event>;
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
  lifetimeCount?: number;
  maxKeepAliveCount?: number;
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
  expectedDataType?: OpcUaDataType;
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

export const OpcUaAttributeIds = {
  NodeId: 1,
  NodeClass: 2,
  BrowseName: 3,
  DisplayName: 4,
  Description: 5,
  Value: 13,
  DataType: 14,
  ValueRank: 15,
  ArrayDimensions: 16,
  AccessLevel: 17,
  UserAccessLevel: 18,
  Executable: 21,
  UserExecutable: 22,
} as const;
