import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { postgresJsDriver } from "./driver.ts";
import { postgresJsConnection, postgresJsTypes } from "./value-types.ts";

describe("postgresJsDriver without postgresJsTypes", () => {
  it("refuses a client created without them, naming the export", () => {
    const sql = postgres("postgres://localhost:1/none");
    expect(() => postgresJsDriver(sql)).toThrow("postgresJsTypes");
  });
});

describe("postgresJsDriver without postgresJsConnection", () => {
  const url = "postgres://localhost:1/none";
  const message =
    "postgresJsDriver needs a client created with postgres(url, { connection: postgresJsConnection }), which sets DateStyle=ISO and bytea_output=hex";

  it("refuses a client created without it, naming the export", () => {
    const sql = postgres(url, { types: postgresJsTypes });
    expect(() => postgresJsDriver(sql)).toThrow(message);
  });

  it("refuses a client whose URL sets another DateStyle", () => {
    const sql = postgres(`${url}?datestyle=SQL`, {
      types: postgresJsTypes,
      connection: postgresJsConnection,
    });
    expect(() => postgresJsDriver(sql)).toThrow(message);
  });

  it("refuses a client that sets another bytea_output", () => {
    const sql = postgres(url, {
      types: postgresJsTypes,
      connection: { ...postgresJsConnection, BYTEA_OUTPUT: "escape" },
    });
    expect(() => postgresJsDriver(sql)).toThrow(message);
  });

  it("accepts the settings in any case and with a date order", () => {
    const sql = postgres(url, {
      types: postgresJsTypes,
      connection: { datestyle: "iso, dmy", bytea_output: "HEX" },
    });
    expect(() => postgresJsDriver(sql)).not.toThrow();
  });
});
