export interface BuildInfo {
  buildVersion: string;
}

export interface HealthStatus {
  status: "ok" | "ready";
}

export type ErrorCode =
  | "authentication_required"
  | "bad_request"
  | "confirmation_required"
  | "controller_required"
  | "controller_generation_mismatch"
  | "challenge_expired"
  | "connection_required"
  | "mutation_not_allowed"
  | "operation_id_limit_reached"
  | "operation_result_unavailable"
  | "origin_rejected"
  | "request_too_large"
  | "safety_generation_mismatch"
  | "watchlist_limit_reached"
  | "browse_budget_exhausted";

export type OperationId = string;
export type CorrelationId = string;

export interface ApiError {
  code: ErrorCode;
  message: string;
  correlationId: CorrelationId;
  operationId?: OperationId;
  retryable?: boolean;
}

export interface ControllerState {
  role: "controller" | "observer";
  controllerGeneration: number;
  leaseExpiresAt?: string;
}

export interface SafetyState {
  readOnly: boolean;
  safetyGeneration: number;
  reason?: string;
}

export interface ServerCertificateSummary {
  algorithm: "sha256";
  fingerprint: string;
}

export interface CertificateReference {
  displayName: string;
  reference: string;
}

export interface ConnectionSummary {
  state: "disconnected" | "connecting" | "connected" | "recovering" | "lost";
  endpoint?: string;
  securityPolicy?: string;
  securityMode?: "None" | "Sign" | "SignAndEncrypt";
  identityStatus?: "unverified" | "verified" | "replacementPending" | "notApplicable";
  serverCertificate?: ServerCertificateSummary;
  clientCertificate?: CertificateReference;
}

export interface LiveValue {
  displayValue: string;
  status: string;
  sourceTimestamp?: string;
  serverTimestamp?: string;
  stale: boolean;
  outOfRange?: boolean;
}

export interface AddressSpaceNode {
  nodeId: string;
  nodeClass:
    | "Object"
    | "Variable"
    | "Method"
    | "View"
    | "DataType"
    | "ReferenceType"
    | "ObjectType"
    | "VariableType";
  browseName: string;
  displayName: string;
  dataType?: string;
  access?: "read" | "readWrite" | "none";
  liveValue?: LiveValue;
}

export interface Snapshot {
  sequence: number;
  buildVersion: string;
  generatedAt: string;
  controller: ControllerState;
  safety: SafetyState;
  connection: ConnectionSummary;
  selectedNodeId?: string;
  nodes: AddressSpaceNode[];
}

export type EventType =
  | "snapshot-required"
  | "ownership-changed"
  | "safety-changed"
  | "connection-changed"
  | "live-value-changed";

export interface SnapshotRequiredPayload {
  reason: "initial" | "reconnect" | "gap" | "version-mismatch" | "slow-client";
}

export interface OwnershipChangedPayload {
  role: "controller" | "observer";
  controllerGeneration: number;
}

export interface SafetyChangedPayload {
  readOnly: boolean;
  safetyGeneration: number;
  reason?: string;
}

export interface ConnectionChangedPayload {
  state: "disconnected" | "connecting" | "connected" | "recovering" | "lost";
  identityStatus?: "unverified" | "verified" | "replacementPending" | "notApplicable";
}

export interface LiveValueChangedPayload {
  nodeId: string;
  liveValue: LiveValue;
}

export interface EventEnvelope {
  sequence: number;
  buildVersion: string;
  type: EventType;
  payload:
    | SnapshotRequiredPayload
    | OwnershipChangedPayload
    | SafetyChangedPayload
    | ConnectionChangedPayload
    | LiveValueChangedPayload;
}

export interface DiagnosticRecord {
  actor: string;
  endpoint: string;
  controllerGeneration: number;
  nodeId?: string;
  operationId: OperationId;
  correlationId: CorrelationId;
  outcome: "succeeded" | "rejected" | "unknown";
}

export type DiagnosticReport = DiagnosticRecord[];

export type MutationKind = "variable-write" | "method-call";

export interface PrepareMutationRequest {
  operationId: OperationId;
  kind: MutationKind;
  targetNodeId: string;
  inputDigest: string;
}

export interface MutationChallenge {
  operationId: OperationId;
  challenge: string;
  expiresAt: string;
  controllerGeneration: number;
  connectionGeneration: number;
  safetyGeneration: number;
  kind?: MutationKind;
  targetNodeId?: string;
}

export interface PrepareMutationResponse {
  challenge: MutationChallenge;
}

export interface ConfirmMutationRequest {
  challenge: string;
}

export type OperationStatus = "succeeded" | "rejected" | "unknown" | "retained";

export interface OperationOutcome {
  operationId: OperationId;
  correlationId: CorrelationId;
  status: OperationStatus;
  code?: ErrorCode;
  completedAt?: string;
}
