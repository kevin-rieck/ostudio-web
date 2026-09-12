import {
  coerceNodeId,
  DataType,
  LocalizedText,
  Range,
  StatusCodes,
  Variant,
} from "node-opcua";
import { describe, expect, it } from "vitest";
import {
  projectDataValue,
  projectLocalizedText,
  projectReference,
  projectVariant,
} from "./projection";

describe("node-opcua transport projection", () => {
  it.each([
    [DataType.Null, null, null],
    [DataType.Boolean, true, true],
    [DataType.SByte, -128, -128],
    [DataType.Byte, 255, 255],
    [DataType.Int16, -32_768, -32_768],
    [DataType.UInt16, 65_535, 65_535],
    [DataType.Int32, -2_147_483_648, -2_147_483_648],
    [DataType.UInt32, 4_294_967_295, 4_294_967_295],
    [DataType.Int64, "-9223372036854775808", "-9223372036854775808"],
    [DataType.UInt64, "18446744073709551615", "18446744073709551615"],
    [DataType.Float, 1.25, 1.25],
    [DataType.Double, -9.5, -9.5],
    [DataType.String, "text", "text"],
    [DataType.DateTime, new Date("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z"],
    [DataType.Guid, "01234567-89ab-cdef-0123-456789abcdef", "01234567-89ab-cdef-0123-456789abcdef"],
    [DataType.ByteString, Buffer.from([1, 2, 3]), "AQID"],
    [DataType.XmlElement, "<x />", "<x />"],
    [DataType.NodeId, coerceNodeId("ns=2;s=Node"), "ns=2;s=Node"],
    [DataType.ExpandedNodeId, { toString: () => "ns=2;s=Expanded" }, "ns=2;s=Expanded"],
    [DataType.StatusCode, { name: "Good", value: 0 }, { name: "Good", value: 0 }],
    [DataType.QualifiedName, { namespaceIndex: 2, name: "Name" }, { namespaceIndex: 2, name: "Name" }],
    [DataType.LocalizedText, { locale: "en-US", text: "Text" }, { locale: "en-US", text: "Text" }],
    [DataType.ExtensionObject, { low: 1, high: 2 }, { low: 1, high: 2 }],
    [DataType.DataValue, { statusCode: StatusCodes.Good, value: new Variant({ dataType: DataType.Int32, value: 3 }) }, {
      status: { name: "Good", value: 0 },
      sourceTimestamp: undefined,
      serverTimestamp: undefined,
      sourcePicoseconds: undefined,
      serverPicoseconds: undefined,
      value: { dataType: "Int32", arrayType: "Scalar", value: 3 },
    }],
    [DataType.Variant, { dataType: DataType.Int32, arrayType: "Scalar", value: 4 }, {
      dataType: 6,
      arrayType: "Scalar",
      value: 4,
    }],
    [DataType.DiagnosticInfo, { symbolicId: 1, additionalInfo: "info" }, { symbolicId: 1, additionalInfo: "info" }],
  ] as const)("projects every supported scalar data type", (dataType, value, expected) => {
    expect(projectVariant({ dataType, arrayType: 0, value } as unknown as Variant).value).toEqual(expected);
  });

  it("bounds projected Variant arrays and matrix dimensions", () => {
    const variant = projectVariant({
      dataType: DataType.Int32,
      arrayType: 1,
      value: Array.from({ length: 2_048 }, (_, index) => index),
      dimensions: Array.from({ length: 2_048 }, () => 1),
    } as unknown as Variant);

    expect(variant.value).toHaveLength(1_024);
    expect(variant.dimensions).toHaveLength(1_024);
  });

  it("bounds nested values with depth, cycles, and one shared budget", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(projectVariant({ dataType: DataType.ExtensionObject, arrayType: 0, value: cyclic } as unknown as Variant).value).toEqual({
      self: "[object omitted: cycle]",
    });

    let nested: unknown = "leaf";
    for (let index = 0; index < 9; index += 1) nested = [nested];
    expect(JSON.stringify(projectVariant({ dataType: DataType.ExtensionObject, arrayType: 0, value: nested } as unknown as Variant).value)).toContain(
      "[object omitted: depth limit]",
    );

    const projected = projectVariant({
      dataType: DataType.ExtensionObject,
      arrayType: 1,
      value: Array.from({ length: 1_024 }, () => ({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5 })),
    } as unknown as Variant);
    expect(Array.isArray(projected.value)).toBe(true);
    expect((projected.value as unknown[]).length).toBeLessThan(1_024);
    expect(JSON.stringify(projected.value)).toContain("_truncated");
  });

  it("bounds projected discovery strings and reference identifiers", () => {
    const oversized = "x".repeat(5_000);
    expect(projectLocalizedText({ locale: oversized, text: oversized })).toEqual({
      locale: `${"x".repeat(4_096)}…`,
      text: `${"x".repeat(4_096)}…`,
    });
    const reference = projectReference({
      nodeId: { toString: () => "ns=1;s=node" },
      browseName: { namespaceIndex: 1, name: "browse" },
      displayName: { text: "display" },
      nodeClass: 2,
      referenceTypeId: { toString: () => oversized },
      typeDefinition: { toString: () => oversized },
      isForward: true,
    });
    expect(reference.referenceTypeId).toBe(`${"x".repeat(4_096)}…`);
    expect(reference.typeDefinition).toBe(`${"x".repeat(4_096)}…`);
  });

  it("projects structured OPC UA values without exposing library objects", () => {
    const localizedText = projectVariant(
      new Variant({
        dataType: DataType.LocalizedText,
        value: new LocalizedText({ locale: "en-US", text: "Pressure" }),
      }),
    );
    const range = projectVariant(
      new Variant({
        dataType: DataType.ExtensionObject,
        value: new Range({ low: 1.5, high: 9.5 }),
      }),
    );
    const statusCode = projectVariant(new Variant({ dataType: DataType.StatusCode, value: StatusCodes.Bad }));
    const dataValue = projectDataValue({
      statusCode: StatusCodes.Good,
      sourceTimestamp: new Date("2026-01-02T03:04:05.000Z"),
      value: new Variant({ dataType: DataType.Int32, value: 7 }),
    });

    expect(localizedText.value).toEqual({ locale: "en-US", text: "Pressure" });
    expect(range.value).toEqual({ low: 1.5, high: 9.5 });
    expect(statusCode.value).toEqual({ name: "Bad", value: StatusCodes.Bad.value });
    expect(dataValue).toEqual({
      status: { name: "Good", value: 0 },
      sourceTimestamp: "2026-01-02T03:04:05.000Z",
      serverTimestamp: undefined,
      value: {
        dataType: "Int32",
        arrayType: "Scalar",
        value: 7,
      },
    });
  });
});
