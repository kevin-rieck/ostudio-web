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
const MAX_PROJECTION_VALUES = 4_096;

type ProjectionContext = {
  ancestors: WeakSet<object>;
  remaining: number;
};

function projectionContext(): ProjectionContext {
  return { ancestors: new WeakSet<object>(), remaining: MAX_PROJECTION_VALUES };
}

export function boundedString(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function projectObject(value: ObjectLike, depth: number, context: ProjectionContext): TransportValue {
  if (depth >= MAX_DEPTH) return "[object omitted: depth limit]";
  if (context.ancestors.has(value)) return "[object omitted: cycle]";

  context.ancestors.add(value);
  const keys = Object.keys(value);
  const result: { [key: string]: TransportValue } = {};
  for (const key of keys.slice(0, MAX_OBJECT_PROPERTIES)) {
    const property = value[key];
    if (property !== undefined && typeof property !== "function") {
      if (context.remaining === 0) {
        result._truncated = true;
        break;
      }
      context.remaining -= 1;
      result[boundedString(key)] = projectValue(property, depth + 1, context);
    }
  }
  if (keys.length > MAX_OBJECT_PROPERTIES) result._truncated = true;
  context.ancestors.delete(value);
  return result;
}

function projectArray(
  value: ArrayLike<unknown>,
  depth: number,
  context: ProjectionContext,
  projectItem: (item: unknown, depth: number) => TransportValue,
  appendLengthMarker = true,
): TransportValue[] {
  const projected: TransportValue[] = [];
  const length = Math.min(value.length, MAX_ARRAY_LENGTH);
  const valueLength = appendLengthMarker && value.length > length ? length - 1 : length;
  for (let index = 0; index < valueLength; index += 1) {
    if (context.remaining === 0) {
      projected.push("[array truncated]");
      break;
    }
    context.remaining -= 1;
    projected.push(projectItem(value[index], depth + 1));
  }
  if (appendLengthMarker && value.length > length) projected.push("[array truncated]");
  return projected;
}

function projectValue(value: unknown, depth = 0, context = projectionContext()): TransportValue {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "string") {
    return value === undefined ? null : typeof value === "string" ? boundedString(value) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (Buffer.isBuffer(value)) return value.subarray(0, 48 * 1024).toString("base64");
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[object omitted: depth limit]";
    if (context.ancestors.has(value)) return "[object omitted: cycle]";
    context.ancestors.add(value);
    const projected = projectArray(value, depth, context, (item, itemDepth) => projectValue(item, itemDepth, context));
    context.ancestors.delete(value);
    return projected;
  }
  if (ArrayBuffer.isView(value)) {
    if (depth >= MAX_DEPTH) return "[object omitted: depth limit]";
    return projectArray(value as unknown as ArrayLike<unknown>, depth, context, (item) => projectValue(item, depth + 1, context));
  }
  if (typeof value === "object") return projectObject(value as ObjectLike, depth, context);
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

function projectVariantValue(variant: Variant, context: ProjectionContext, depth: number): TransportValue {
  if (variant.arrayType !== VariantArrayType.Scalar) {
    const values = Array.isArray(variant.value)
      ? variant.value
      : ArrayBuffer.isView(variant.value) && !(variant.value instanceof DataView)
        ? (variant.value as unknown as ArrayLike<unknown>)
        : [];
    if (context.ancestors.has(values)) return "[object omitted: cycle]";
    context.ancestors.add(values);
    const projected = projectArray(values, depth, context, (value, itemDepth) => projectScalar(value, variant.dataType, context, itemDepth), false);
    context.ancestors.delete(values);
    return projected;
  }
  return projectScalar(variant.value, variant.dataType, context, depth);
}

function projectScalar(value: unknown, dataType: DataType, context: ProjectionContext, depth: number): TransportValue {
  switch (dataType) {
    case DataType.StatusCode:
      if (value && typeof value === "object" && "name" in value && "value" in value) {
        const status = value as { name: string; value: number };
        return { name: boundedString(status.name), value: status.value };
      }
      return projectValue(value, depth, context);
    case DataType.DataValue:
      if (value && typeof value === "object" && "statusCode" in value) {
        return projectDataValueInternal(value as Parameters<typeof projectDataValue>[0], context, depth) as unknown as TransportValue;
      }
      return projectValue(value, depth, context);
    case DataType.Int64:
      return projectInt64(value, true);
    case DataType.UInt64:
      return projectInt64(value, false);
    case DataType.ByteString:
      return Buffer.isBuffer(value) ? value.subarray(0, 48 * 1024).toString("base64") : projectValue(value, depth, context);
    case DataType.NodeId:
    case DataType.ExpandedNodeId:
      return value && typeof value === "object" && "toString" in value
        ? boundedString(String(value))
        : projectValue(value, depth, context);
    case DataType.DateTime:
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : projectValue(value, depth, context);
    default:
      return projectValue(value, depth, context);
  }
}

function projectVariantInternal(variant: Variant, context: ProjectionContext, depth: number): OpcUaVariant {
  const result: OpcUaVariant = {
    dataType: dataTypeName(variant.dataType),
    arrayType: arrayTypeName(variant.arrayType),
    value: projectVariantValue(variant, context, depth),
  };
  if (variant.dimensions?.length) {
    result.dimensions = variant.dimensions
      .slice(0, MAX_ARRAY_LENGTH)
      .map((dimension) => Number.isSafeInteger(dimension) && dimension >= 0
        ? Math.min(dimension, MAX_ARRAY_LENGTH)
        : 0);
  }
  return result;
}

export function projectVariant(variant: Variant): OpcUaVariant {
  return projectVariantInternal(variant, projectionContext(), 0);
}

export function projectStatusCode(statusCode: { name: string; value: number }): OpcUaStatusCode {
  return { name: boundedString(statusCode.name), value: statusCode.value };
}

function projectDataValueInternal(dataValue: {
  statusCode: { name: string; value: number };
  sourceTimestamp?: Date | null;
  serverTimestamp?: Date | null;
  sourcePicoseconds?: number;
  serverPicoseconds?: number;
  value?: Variant | null;
}, context: ProjectionContext, depth: number): OpcUaDataValue {
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
    value: dataValue.value ? projectVariantInternal(dataValue.value, context, depth + 1) : undefined,
  };
}

export function projectDataValue(dataValue: Parameters<typeof projectDataValueInternal>[0]): OpcUaDataValue {
  return projectDataValueInternal(dataValue, projectionContext(), 0);
}

export function projectLocalizedText(value: { locale?: string | null; text?: string | null }): OpcUaLocalizedText {
  return {
    locale: value.locale === null || value.locale === undefined ? undefined : boundedString(value.locale),
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
    referenceTypeId: reference.referenceTypeId ? boundedString(reference.referenceTypeId.toString()) : undefined,
    typeDefinition: reference.typeDefinition ? boundedString(reference.typeDefinition.toString()) : undefined,
    isForward: reference.isForward,
  };
}
