import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  array,
  field,
  literal,
  nullable,
  number,
  optionalField,
  parseJson,
  readEventPayload,
  record,
  string,
} from "./github-json.ts";

describe("parseJson", () => {
  test("returns the parsed value", () => {
    expect(parseJson("[1]", "x")).toEqual([1]);
  });

  test("names the source when the text is not JSON", () => {
    expect(() => parseJson("{nope", "gh api")).toThrow("gh api: invalid JSON");
  });
});

describe("readers", () => {
  test("string and number accept their type and name the path otherwise", () => {
    expect(string("a", "$")).toBe("a");
    expect(number(1, "$")).toBe(1);
    expect(() => string(1, "$.title")).toThrow("$.title: expected string, got number");
    expect(() => number("1", "$.n")).toThrow("$.n: expected number, got string");
  });

  test("literal accepts only the listed values", () => {
    const state = literal("open", "closed");
    expect(state("open", "$")).toBe("open");
    expect(() => state("merged", "$.state")).toThrow('$.state: expected "open" | "closed"');
  });

  test("array reads each element and names the index", () => {
    expect(array(number)([1, 2], "$")).toEqual([1, 2]);
    expect(() => array(number)([1, "x"], "$.ids")).toThrow("$.ids[1]: expected number");
    expect(() => array(number)({}, "$.ids")).toThrow("$.ids: expected array, got object");
  });

  test("record rejects null, arrays, and primitives", () => {
    expect(record({ a: 1 }, "$")).toEqual({ a: 1 });
    expect(() => record(null, "$")).toThrow("$: expected object, got null");
    expect(() => record([], "$")).toThrow("$: expected object, got array");
    expect(() => record("x", "$")).toThrow("$: expected object, got string");
  });
});

describe("nullable", () => {
  test("passes null and reads anything else", () => {
    expect(nullable(record)(null, "$")).toBeNull();
    expect(nullable(record)({ a: 1 }, "$")).toEqual({ a: 1 });
    expect(() => nullable(record)(undefined, "$.m")).toThrow("$.m: expected object, got undefined");
  });
});

describe("field", () => {
  test("reads a present key", () => {
    expect(field({ id: 1 }, "id", number, "$.issue")).toBe(1);
  });

  test("names the path of a missing or mistyped key", () => {
    expect(() => field({}, "id", number, "$.issue")).toThrow(
      "$.issue.id: expected number, got undefined",
    );
    expect(() => field({ id: "1" }, "id", number, "$.issue")).toThrow(
      "$.issue.id: expected number",
    );
  });
});

describe("optionalField", () => {
  test("passes a missing key through as undefined", () => {
    expect(optionalField({}, "n", number, "$")).toBeUndefined();
  });

  test("reads a present key and rejects a mistyped one", () => {
    expect(optionalField({ n: 2 }, "n", number, "$")).toBe(2);
    expect(() => optionalField({ n: "x" }, "n", number, "$")).toThrow("$.n: expected number");
  });
});

describe("readEventPayload", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  test("parses the file named by GITHUB_EVENT_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "event-"));
    const path = join(dir, "event.json");
    writeFileSync(path, '{"a":1}');
    expect(readEventPayload({ GITHUB_EVENT_PATH: path })).toEqual({ a: 1 });
    expect(process.exitCode).toBeUndefined();
  });

  test("reports the unset variable with exit code 1", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readEventPayload({})).toBeUndefined();
    expect(error).toHaveBeenCalledWith("Set GITHUB_EVENT_PATH");
    expect(process.exitCode).toBe(1);
  });
});
