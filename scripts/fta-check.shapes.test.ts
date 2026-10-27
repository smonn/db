import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { judge, main, parseBaselines, parseScores, threshold } from "./fta-check.ts";

const over = threshold + 5;

describe("parseScores entries", () => {
  test.each([
    ["a number", "[5]"],
    ["null", "[null]"],
    ["a string", '["a.ts"]'],
    ["no file_name", '[{"fta_score":1}]'],
    ["a file_name that is not a string", '[{"file_name":1,"fta_score":1}]'],
    ["no fta_score", '[{"file_name":"a.ts"}]'],
    ["an fta_score that is not a number", '[{"file_name":"a.ts","fta_score":"1"}]'],
  ])("rejects an entry that is %s", (_name, json) => {
    expect(() => parseScores("src", json)).toThrow("fta returned an entry without a score");
  });
});

describe("parseBaselines values", () => {
  test.each(["5", '"x"', "true"])("rejects %s, which is not an object", (json) => {
    expect(() => parseBaselines(json)).toThrow("must hold an object");
  });
});

describe("judge at the threshold", () => {
  test("lets a new file score exactly the threshold", () => {
    const outcome = judge(new Map([["a.ts", threshold]]), new Map(), "check");
    expect(outcome).toEqual({ failures: [], stale: [], next: new Map() });
  });

  test("drops the baseline of a file that now scores exactly the threshold", () => {
    const outcome = judge(new Map([["a.ts", threshold]]), new Map([["a.ts", over]]), "check");
    expect(outcome.stale).toEqual([
      `a.ts scores ${threshold}, within ${threshold}, so it needs no baseline.`,
    ]);
    expect(outcome.next).toEqual(new Map());
  });

  test("says what init recorded", () => {
    expect(judge(new Map([["a.ts", over]]), new Map(), "init").stale).toEqual([
      `a.ts recorded at ${over}.`,
    ]);
  });
});

const scores = (list: [string, number][]) => (sourceDir: string) =>
  sourceDir === "src" ? list : [];

describe("main reports", () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fta-check-shapes-"));
    baselinePath = join(dir, "fta-baseline.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("counts the files within their limits and exits clean", () => {
    writeFileSync(baselinePath, "{}");
    main([], scores([["src/a.ts", 1]]), baselinePath);
    expect(console.log).toHaveBeenCalledWith("fta: 1 files within their limits.");
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("prints only the failures, one per line, when no baseline is stale", () => {
    writeFileSync(baselinePath, "{}");
    main(
      [],
      scores([
        ["src/a.ts", over],
        ["src/b.ts", over],
      ]),
      baselinePath,
    );
    expect(console.error).toHaveBeenCalledWith(
      [
        `src/a.ts scores ${over}. A file without a baseline must score ${threshold} or less.`,
        `src/b.ts scores ${over}. A file without a baseline must score ${threshold} or less.`,
      ].join("\n"),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("lists the stale lines and the fix after the failures", () => {
    writeFileSync(baselinePath, `{"src/a.ts": ${over + 1}, "src/gone.ts": ${over}}`);
    main([], scores([["src/a.ts", over]]), baselinePath);
    expect(console.error).toHaveBeenCalledWith(
      [
        `src/a.ts improved from ${over + 1} to ${over}.`,
        "src/gone.ts has a baseline but no longer exists.",
        `Run \`pnpm fta:update\` and commit ${baselinePath}.`,
      ].join("\n"),
    );
  });

  test("says what --init and --update changed", () => {
    main(["--init"], scores([["src/a.ts", over]]), baselinePath);
    expect(console.log).toHaveBeenCalledWith(`Updated: src/a.ts recorded at ${over}.`);
    main(["--update"], scores([["src/a.ts", over - 1]]), baselinePath);
    expect(console.log).toHaveBeenCalledWith(
      `Updated: src/a.ts improved from ${over} to ${over - 1}.`,
    );
    expect(readFileSync(baselinePath, "utf8")).toBe(`{\n  "src/a.ts": ${over - 1}\n}\n`);
  });

  test("reads its flag from the command line by default", () => {
    const argv = process.argv;
    process.argv = ["node", "fta-check.ts"];
    writeFileSync(baselinePath, "{}");
    try {
      main(undefined, scores([]), baselinePath);
    } finally {
      process.argv = argv;
    }
    expect(console.log).toHaveBeenCalledWith("fta: 0 files within their limits.");
  });

  test("reads and writes fta-baseline.json in the working directory by default", () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync("fta-baseline.json", `{"src/a.ts": ${over + 1}}`);
      main(["--update"], scores([["src/a.ts", over]]));
      expect(readFileSync("fta-baseline.json", "utf8")).toBe(`{\n  "src/a.ts": ${over}\n}\n`);
    } finally {
      process.chdir(cwd);
    }
  });
});
