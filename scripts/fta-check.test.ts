import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { judge, main, parseBaselines, parseScores, threshold } from "./fta-check.ts";

const over = threshold + 5;
const under = threshold - 5;

let dir: string;
let baselinePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fta-check-"));
  baselinePath = join(dir, "fta-baseline.json");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("parseScores", () => {
  test("prefixes each file with its folder and rounds to two decimals", () => {
    const json = JSON.stringify([{ file_name: "a.ts", fta_score: 12.3456 }, { other: 1 }]);
    expect(parseScores("src", json)).toEqual([["src/a.ts", 12.35]]);
  });

  test("rejects output that isn't a list", () => {
    expect(() => parseScores("src", "{}")).toThrow("fta returned no file list for src");
  });
});

describe("parseBaselines", () => {
  test("reads a file-to-score object", () => {
    expect(parseBaselines('{"src/a.ts": 61}')).toEqual(new Map([["src/a.ts", 61]]));
  });

  test("rejects anything but an object", () => {
    expect(() => parseBaselines("[]")).toThrow("must hold an object");
    expect(() => parseBaselines("null")).toThrow("must hold an object");
  });

  test("rejects a baseline that isn't a number, by file name", () => {
    expect(() => parseBaselines('{"src/a.ts": "61"}')).toThrow(
      "src/a.ts's baseline is not a number",
    );
  });
});

describe("judge", () => {
  test("passes files within the threshold that have no baseline", () => {
    expect(judge(new Map([["a.ts", under]]), new Map(), "check")).toEqual({
      failures: [],
      stale: [],
      next: new Map(),
    });
  });

  test("fails a file over the threshold without a baseline", () => {
    const { failures } = judge(new Map([["a.ts", over]]), new Map(), "check");
    expect(failures).toEqual([
      `a.ts scores ${over}. A file without a baseline must score ${threshold} or less.`,
    ]);
  });

  test("records a file over the threshold on init", () => {
    const outcome = judge(new Map([["a.ts", over]]), new Map(), "init");
    expect(outcome.failures).toEqual([]);
    expect(outcome.next).toEqual(new Map([["a.ts", over]]));
  });

  test("fails a file that got worse than its baseline and keeps the baseline", () => {
    const outcome = judge(new Map([["a.ts", over + 1]]), new Map([["a.ts", over]]), "update");
    expect(outcome.failures).toEqual([`a.ts scores ${over + 1}, worse than its baseline ${over}.`]);
    expect(outcome.next).toEqual(new Map([["a.ts", over]]));
  });

  test("keeps an unchanged baseline without reporting it", () => {
    const outcome = judge(new Map([["a.ts", over]]), new Map([["a.ts", over]]), "check");
    expect(outcome).toEqual({ failures: [], stale: [], next: new Map([["a.ts", over]]) });
  });

  test("lowers an improved baseline and reports it stale", () => {
    const outcome = judge(new Map([["a.ts", over]]), new Map([["a.ts", over + 1]]), "check");
    expect(outcome.stale).toEqual([`a.ts improved from ${over + 1} to ${over}.`]);
    expect(outcome.next).toEqual(new Map([["a.ts", over]]));
  });

  test("drops a baseline whose file is back within the threshold", () => {
    const outcome = judge(new Map([["a.ts", under]]), new Map([["a.ts", over]]), "check");
    expect(outcome.stale).toEqual([
      `a.ts scores ${under}, within ${threshold}, so it needs no baseline.`,
    ]);
    expect(outcome.next).toEqual(new Map());
  });

  test("reports a baseline whose file is gone", () => {
    const { stale } = judge(new Map(), new Map([["a.ts", over]]), "check");
    expect(stale).toEqual(["a.ts has a baseline but no longer exists."]);
  });
});

const scores =
  (byDir: Record<string, [string, number][]>) =>
  (sourceDir: string): [string, number][] =>
    byDir[sourceDir] ?? [];

describe("main", () => {
  test("scans src and scripts", () => {
    const seen: string[] = [];
    writeFileSync(baselinePath, "{}");
    main(
      [],
      (sourceDir) => {
        seen.push(sourceDir);
        return [];
      },
      baselinePath,
    );
    expect(seen).toEqual(["src", "scripts"]);
  });

  test("--init writes the files over the threshold, sorted", () => {
    main(
      ["--init"],
      scores({
        src: [
          ["src/b.ts", over],
          ["src/c.ts", under],
        ],
        scripts: [["scripts/a.ts", over]],
      }),
      baselinePath,
    );
    expect(readFileSync(baselinePath, "utf8")).toBe(
      `{\n  "scripts/a.ts": ${over},\n  "src/b.ts": ${over}\n}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("--init refuses when a baseline file exists", () => {
    writeFileSync(baselinePath, "{}");
    expect(() => {
      main(["--init"], scores({}), baselinePath);
    }).toThrow("--init runs once");
  });

  test("check fails on a stale baseline without writing, and names the fix", () => {
    writeFileSync(baselinePath, `{"src/a.ts": ${over + 1}}`);
    main([], scores({ src: [["src/a.ts", over]] }), baselinePath);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("pnpm fta:update"));
    expect(readFileSync(baselinePath, "utf8")).toBe(`{"src/a.ts": ${over + 1}}`);
  });

  test("--update lowers the baseline and passes", () => {
    writeFileSync(baselinePath, `{"src/a.ts": ${over + 1}}`);
    main(["--update"], scores({ src: [["src/a.ts", over]] }), baselinePath);
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(baselinePath, "utf8")).toBe(`{\n  "src/a.ts": ${over}\n}\n`);
  });

  test("--update still fails on a file worse than its baseline", () => {
    writeFileSync(baselinePath, `{"src/a.ts": ${over}}`);
    main(["--update"], scores({ src: [["src/a.ts", over + 1]] }), baselinePath);
    expect(process.exitCode).toBe(1);
    expect(existsSync(baselinePath)).toBe(true);
  });
});
