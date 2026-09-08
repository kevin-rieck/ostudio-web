import {
  DataType,
  LocalizedText,
  Range,
  StatusCodes,
  Variant,
} from "node-opcua";
import { describe, expect, it } from "vitest";
import { projectDataValue, projectVariant } from "./projection";

describe("node-opcua transport projection", () => {
  it("keeps signed and unsigned 64-bit values as canonical decimal strings", () => {
    const signed = projectVariant(
      new Variant({ dataType: DataType.Int64, value: "-9223372036854775808" }),
    );
    const unsigned = projectVariant(
      new Variant({ dataType: DataType.UInt64, value: "18446744073709551615" }),
    );

    expect(signed.value).toBe("-9223372036854775808");
    expect(unsigned.value).toBe("18446744073709551615");
    expect(typeof signed.value).toBe("string");
    expect(typeof unsigned.value).toBe("string");
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
