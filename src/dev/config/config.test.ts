import { describe, expect, it } from "vitest";
import { defineConfig, parseConfig } from "./config.ts";

const FILE = "smonndb.config.ts";
const base = { definition: "./db/definition.ts", migrations: "./db/migrations" };

describe("defineConfig", () => {
  it("returns the config as given", () => {
    const config = { ...base, url: "postgres://localhost/app" };

    expect(defineConfig(config)).toBe(config);
  });
});

describe("parseConfig", () => {
  it("reads a config with and without a tracking schema", () => {
    const url = "postgres://localhost/app";

    expect(parseConfig({ ...base, url }, FILE)).toStrictEqual({ ...base, url });
    expect(parseConfig({ ...base, url, trackingSchema: "tracking" }, FILE)).toStrictEqual({
      ...base,
      url,
      trackingSchema: "tracking",
    });
  });

  it.each([undefined, null, "config"])("refuses a default export of %s", (value) => {
    expect(() => parseConfig(value, FILE)).toThrow(
      `${FILE} must export defineConfig({ ... }) as its default export`,
    );
  });

  it("refuses unknown keys by name", () => {
    expect(() =>
      parseConfig({ ...base, url: "postgres://", database: "app", schemas: [] }, FILE),
    ).toThrow(`${FILE}: unknown config key database, schemas`);
  });

  it.each(["definition", "migrations"])("refuses a missing or empty %s", (key) => {
    const config = { ...base, url: "postgres://" };

    expect(() => parseConfig({ ...config, [key]: undefined }, FILE)).toThrow(
      `${FILE}: ${key} must be a non-empty path`,
    );
    expect(() => parseConfig({ ...config, [key]: "" }, FILE)).toThrow(
      `${FILE}: ${key} must be a non-empty path`,
    );
  });

  it("refuses an unset url, naming the environment variable to set", () => {
    expect(() => parseConfig({ ...base, url: undefined }, FILE)).toThrow(
      `${FILE}: url is undefined; set the environment variable it reads, such as DATABASE_URL`,
    );
    expect(() => parseConfig({ ...base, url: "" }, FILE)).toThrow(
      `${FILE}: url is empty; set the environment variable it reads, such as DATABASE_URL`,
    );
  });

  it("refuses a url or tracking schema that isn't a string", () => {
    expect(() => parseConfig({ ...base, url: 5432 }, FILE)).toThrow(
      `${FILE}: url must be a string`,
    );
    expect(() => parseConfig({ ...base, url: "postgres://", trackingSchema: 1 }, FILE)).toThrow(
      `${FILE}: trackingSchema must be a string`,
    );
  });
});
