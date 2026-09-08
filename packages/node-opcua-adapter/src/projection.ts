import {
  DataType,
  Int64ToBigInt,
  UInt64ToBigInt,
  VariantArrayType,
} from "node-opcua";
import type { Variant } from "node-opcua";
import type {
  OpcUaDataValue,
  OpcUaDataType,
  OpcUaLocalizedText,
  OpcUaNodeClass,
  OpcUaQualifiedName,
  OpcUaReference,
  OpcUaStatusCode,
  OpcUaVariant,
  TransportValue,
} from "@ostudio/application";

type ObjectLike = Record<string, unknown>;

const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_LENGTH = 1_024;
const MAX_OBJECT_PROPERTIES = 128;
const MAX_DEPTH = 8;

function boundedString(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function projectObject(value: ObjectLike, depth: number): TransportValue {
  if (depth >= MAX_DEPTH) return "[object omitted: depth limit]";

  const result: { [key: string]: TransportValue } = {};
  for (const key of Object.keys(value).slice(0, MAX_OBJECT_PROPERTIES)) {
    const property = value[key];
    if (property !== undefined && typeof property !== "function") {
      result[boundedString(key)] = projectValue(property, depth + 1);
    }
  }
  if (Object.keys(value).length > MAX_OBJECT_PROPERTIES) {
    result._truncated = true;
  }
  return result;
}

function projectValue(value: unknown, depth = 0): TransportValue {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "string") {
    return value === undefined ? null : typeof value === "string" ? boundedString(value) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (Buffer.isBuffer(value)) return value.subarray(0, 48 * 1024).toString("base64");
  if (Array.isArray(value)) {
    const projected = value.slice(0, MAX_ARRAY_LENGTH).map((item) => projectValue(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) projected.push("[array truncated]");
    return projected;
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>).slice(0, MAX_ARRAY_LENGTH);
  }
  if (typeof value === "object") return projectObject(value as ObjectLike, depth);
  return String(value);
}

function projectInt64(value: unknown, signed: boolean): TransportValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return BigInt(value).toString(10);
  }
  const words = value as number[];
  return (signed ? Int64ToBigInt(words) : UInt64ToBigInt(words)).toString(10);
}

function dataTypeName(dataType: DataType): OpcUaDataType {
  return DataType[dataType] as OpcUaDataType;
}

function arrayTypeName(arrayType: VariantArrayType): OpcUaVariant["arrayType"] {
  return VariantArrayType[arrayType] as OpcUaVariant["arrayType"];
}

function projectVariantValue(variant: Variant): TransportValue {
  if (variant.arrayType !== VariantArrayType.Scalar) {
    const values = Array.isArray(variant.value) || ArrayBuffer.isView(variant.value)
      ? Array.from(variant.value as ArrayLike<unknown>)
      : [];
    return values.map((value) => projectScalar(value, variant.dataType));
  }
  return projectScalar(variant.value, variant.dataType);
}

function projectScalar(value: unknown, dataType: DataType): TransportValue {
  switch (dataType) {
    case DataType.StatusCode:
      if (value && typeof value === "object" && "name" in value && "value" in value) {
        const status = value as { name: string; value: number };
        return { name: boundedString(status.name), value: status.value };
      }
      return projectValue(value);
    case DataType.DataValue:
      if (value && typeof value === "object" && "statusCode" in value) {
        return projectDataValue(value as Parameters<typeof projectDataValue>[0]) as unknown as TransportValue;
      }
      return projectValue(value);
    case DataType.Int64:
      return projectInt64(value, true);
    case DataType.UInt64:
      return projectInt64(value, false);
    case DataType.ByteString:
      return Buffer.isBuffer(value) ? value.subarray(0, 48 * 1024).toString("base64") : projectValue(value);
    case DataType.NodeId:
    case DataType.ExpandedNodeId:
      return value && typeof value === "object" && "toString" in value
        ? boundedString(String(value))
        : projectValue(value);
    case DataType.DateTime:
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : projectValue(value);
    default:
      return projectValue(value);
  }
}

export function projectVariant(variant: Variant): OpcUaVariant {
  const result: OpcUaVariant = {
    dataType: dataTypeName(variant.dataType),
    arrayType: arrayTypeName(variant.arrayType),
    value: projectVariantValue(variant),
  };
  if (variant.dimensions?.length) result.dimensions = [...variant.dimensions];
  return result;
}

export function projectStatusCode(statusCode: { name: string; value: number }): OpcUaStatusCode {
  return { name: boundedString(statusCode.name), value: statusCode.value };
}

export function projectDataValue(dataValue: {
  statusCode: { name: string; value: number };
  sourceTimestamp?: Date | null;
  serverTimestamp?: Date | null;
  sourcePicoseconds?: number;
  serverPicoseconds?: number;
  value?: Variant | null;
}): OpcUaDataValue {
  return {
    status: projectStatusCode(dataValue.statusCode),
    sourceTimestamp: dataValue.sourceTimestamp && !Number.isNaN(dataValue.sourceTimestamp.getTime())
      ? dataValue.sourceTimestamp.toISOString()
      : undefined,
    serverTimestamp: dataValue.serverTimestamp && !Number.isNaN(dataValue.serverTimestamp.getTime())
      ? dataValue.serverTimestamp.toISOString()
      : undefined,
    sourcePicoseconds: dataValue.sourcePicoseconds,
    serverPicoseconds: dataValue.serverPicoseconds,
    value: dataValue.value ? projectVariant(dataValue.value) : undefined,
  };
}

export function projectLocalizedText(value: { locale?: string | null; text?: string | null }): OpcUaLocalizedText {
  return {
    locale: value.locale === null ? undefined : value.locale,
    text: value.text === null ? undefined : value.text === undefined ? undefined : boundedString(value.text),
  };
}

export function projectQualifiedName(value: { namespaceIndex: number; name?: string | null }): OpcUaQualifiedName {
  return {
    namespaceIndex: value.namespaceIndex,
    name: value.name == null ? undefined : boundedString(value.name),
  };
}

export function projectNodeClass(nodeClass: number): OpcUaNodeClass {
  const name = ["Unspecified", "Object", "Variable", "Method", "ObjectType", "VariableType", "ReferenceType", "DataType", "View"];
  return name[Math.log2(nodeClass)] as OpcUaNodeClass ?? "Unspecified";
}

export function projectReference(reference: {
  nodeId: { toString(): string };
  browseName: { namespaceIndex: number; name?: string | null };
  displayName: { locale?: string | null; text?: string | null };
  nodeClass: number;
  referenceTypeId?: { toString(): string };
  typeDefinition?: { toString(): string };
  isForward: boolean;
}): OpcUaReference {
  return {
    nodeId: boundedString(reference.nodeId.toString()),
    browseName: projectQualifiedName(reference.browseName),
    displayName: projectLocalizedText(reference.displayName),
    nodeClass: projectNodeClass(reference.nodeClass),
    referenceTypeId: reference.referenceTypeId?.toString(),
    typeDefinition: reference.typeDefinition?.toString(),
    isForward: reference.isForward,
  };
}
