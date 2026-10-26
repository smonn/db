import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { format, main, parseDiagnostics, parseMax, type Run } from "./complexity.ts";

const named =
  "src/a.ts:14:1: function `alpha` has a complexity of 11. Maximum allowed is 8. [Error/eslint(complexity)]";
const asyncMethod =
  "src/b.ts:3:8: async function `beta` has a complexity of 9. Maximum allowed is 8. [Error/eslint(complexity)]";
const anonymous =
  "src/a.ts:2:22: function has a complexity of 9. Maximum allowed is 8. [Error/eslint(complexity)]";

const broken: Run = () => {
  return { status: 1, stdout: "Failed to parse oxlint configuration" };
};

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logged.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDiagnostics", () => {
  test("reads score, name, file, and line, and skips the summary", () => {
    const output = [named, asyncMethod, "", "2 problems"].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      { score: 11, name: "alpha", file: "src/a.ts", line: 14 },
      { score: 9, name: "beta", file: "src/b.ts", line: 3 },
    ]);
  });

  test("names an anonymous function", () => {
    expect(parseDiagnostics(anonymous)).toEqual([
      { score: 9, name: "<anonymous>", file: "src/a.ts", line: 2 },
    ]);
  });
});

describe("format", () => {
  test("sorts worst first, then by file and line", () => {
    const lines = format(parseDiagnostics([asyncMethod, named, anonymous].join("\n")));
    expect(lines).toEqual([
      "11 alpha src/a.ts:14",
      "9 <anonymous> src/a.ts:2",
      "9 beta src/b.ts:3",
    ]);
  });
});

describe("parseMax", () => {
  test("defaults to 6", () => {
    expect(parseMax([])).toBe(6);
  });

  test("reads a whole number", () => {
    expect(parseMax(["8"])).toBe(8);
  });

  test("rejects anything else", () => {
    expect(() => parseMax(["x"])).toThrow('Expected a whole number for max, got "x"');
    expect(() => parseMax(["1", "2"])).toThrow("at most one argument");
  });
});

describe("main", () => {
  test("writes a config with the cap, prints the findings, and removes the config", () => {
    let config = "";
    let configPath = "";
    const run: Run = (path) => {
      configPath = path;
      config = readFileSync(path, "utf8");
      return { status: 1, stdout: `${named}\n\n1 problem\n` };
    };
    main(["8"], run);
    expect(JSON.parse(config)).toEqual({ rules: { complexity: ["error", { max: 8 }] } });
    expect(logged).toEqual(["11 alpha src/a.ts:14"]);
    expect(() => readFileSync(configPath, "utf8")).toThrow("ENOENT");
  });

  test("prints nothing and does not fail when nothing is over the cap", () => {
    main([], () => ({ status: 0, stdout: "" }));
    expect(logged).toEqual([]);
  });

  test("fails when oxlint breaks rather than reporting problems", () => {
    expect(() => {
      main([], broken);
    }).toThrow("oxlint failed (exit 1)");
  });
});
