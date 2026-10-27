import { describe, expect, it } from "vitest";
import { postgresJsTypes } from "./value-types.ts";

const at = new Date("2026-01-01T00:00:00Z");
const atText = "2026-01-01 00:00:00.000+00";

describe("postgresJsTypes serializers", () => {
  it("writes a Date as a timestamp in UTC text", () => {
    expect(postgresJsTypes.timestamp.serialize(at)).toBe(atText);
  });

  it("writes a Date as a timestamptz in UTC text", () => {
    expect(postgresJsTypes.timestamptz.serialize(at)).toBe(atText);
  });
});

describe("postgresJsTypes.boxArray", () => {
  it("covers the box array OID and splits elements on `;`", () => {
    expect(postgresJsTypes.boxArray.to).toBe(1020);
    expect(postgresJsTypes.boxArray.from).toStrictEqual([1020]);
    expect(postgresJsTypes.boxArray.parse("{(1,1),(0,0);(2,2),(1,1)}")).toStrictEqual([
      "(1,1),(0,0)",
      "(2,2),(1,1)",
    ]);
  });
});
