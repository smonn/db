import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OnInterrupt } from "../src/dev/shadow/index.ts";
import {
  checkDisables,
  describeDisables,
  main,
  parseArgs,
  type RunStryker,
} from "./mutation-disables.ts";
import { REPORT } from "./mutation-report.ts";

const disabled = "// Stryker disable next-line StringLiteral: 1 survivor: never shown\nf('x');\n";
const marked = "// Stryker expect next-line StringLiteral: 1 survivor: never shown\nf('x');\n";

type Mutant = { mutatorName: string; status: string; line: number };
const mutant = (mutatorName: string, status: string, line = 2): Mutant => ({
  mutatorName,
  status,
  line,
});
const reportOf = (files: Record<string, { source: string; mutants: Mutant[] }>): string =>
  JSON.stringify({
    files: Object.fromEntries(
      Object.entries(files).map(([file, { source, mutants }]) => [
        file,
        { source, mutants: mutants.map((m) => ({ ...m, location: { start: { line: m.line } } })) },
      ]),
    ),
  });

let dir: string;
const write = (file: string, text: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const read = (file: string): string => readFileSync(join(dir, file), "utf8");
const writeReport = (mutants: Mutant[], file = "a.ts"): void => {
  write(REPORT, reportOf({ [file]: { source: marked, mutants } }));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mutation-disables-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const noInterrupt: OnInterrupt = () => () => {};
const failing: RunStryker = () => Promise.reject(new Error("Stryker failed"));

const describeOne = (mutants: Mutant[], source = marked): string[] =>
  describeDisables(JSON.parse(reportOf({ "a.ts": { source, mutants } })));
const survivedAt = (line: number): Mutant[] => [mutant("StringLiteral", "Survived", line)];

describe("describeDisables", () => {
  test("reports a disable whose survivors match its stated count", () => {
    expect(describeOne([mutant("StringLiteral", "Survived")])).toEqual([
      "a.ts:1 states 1, survivors 1 (StringLiteral 1): matches",
    ]);
  });

  test("counts an uncovered mutant as a survivor and ignores mutants of other mutators", () => {
    const mutants = [
      mutant("StringLiteral", "NoCoverage"),
      mutant("BlockStatement", "Survived"),
      mutant("StringLiteral", "Survived", 3),
    ];
    expect(describeOne(mutants)).toEqual([
      "a.ts:1 states 1, survivors 1 (StringLiteral 1): matches",
    ]);
  });

  test("reports more survivors than stated", () => {
    const mutants = [mutant("StringLiteral", "Survived"), mutant("StringLiteral", "NoCoverage")];
    expect(describeOne(mutants)).toEqual([
      "a.ts:1 states 1, survivors 2 (StringLiteral 2): more survivors than stated: the weekly run lists them all",
    ]);
  });

  test("reports fewer survivors than stated as stale", () => {
    expect(describeOne([mutant("StringLiteral", "Killed")])).toEqual([
      "a.ts:1 states 1, survivors 0 (StringLiteral 0): fewer survivors than stated: stale",
    ]);
  });

  test("lets a timeout stand in for a stated survivor", () => {
    expect(describeOne([mutant("StringLiteral", "Timeout")])).toEqual([
      "a.ts:1 states 1, survivors 0 (StringLiteral 0): matches",
    ]);
  });

  test("reports a disable with no mutant on the next line", () => {
    expect(describeOne([mutant("StringLiteral", "Survived", 5)])).toEqual([
      "a.ts:1 states 1, survivors 0 (StringLiteral 0): no mutant on the next line, so the disable hides nothing",
    ]);
  });

  test("lists the survivors of each mutator a disable names", () => {
    const source =
      "// Stryker expect next-line StringLiteral, BlockStatement: 2 survivors: both\nf('x');\n";
    const mutants = [mutant("StringLiteral", "Survived"), mutant("BlockStatement", "Killed")];
    expect(describeOne(mutants, source)).toEqual([
      "a.ts:1 states 2, survivors 1 (StringLiteral 1, BlockStatement 0): fewer survivors than stated: stale",
    ]);
  });

  test("orders files by name and disables by line", () => {
    const twice = `${marked}${marked}`;
    const lines = describeDisables(
      JSON.parse(
        reportOf({
          "b.ts": { source: marked, mutants: survivedAt(2) },
          "a.ts": { source: twice, mutants: [...survivedAt(2), ...survivedAt(4)] },
        }),
      ),
    );
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["a.ts:1", "a.ts:3", "b.ts:1"]);
  });
});

describe("checkDisables", () => {
  test("runs Stryker on the marked files, prints each disable, and restores them", async () => {
    write("a.ts", disabled);
    const run = vi.fn<RunStryker>(() => {
      expect(read("a.ts")).toBe(marked);
      writeReport([mutant("StringLiteral", "Survived")]);
      return Promise.resolve();
    });
    await checkDisables(["a.ts"], dir, run, noInterrupt);
    expect(run).toHaveBeenCalledWith(["a.ts"], expect.any(AbortSignal));
    expect(read("a.ts")).toBe(disabled);
    expect(console.log).toHaveBeenCalledWith(
      "a.ts:1 states 1, survivors 1 (StringLiteral 1): matches",
    );
  });

  test("leaves a file with no disable out of the run and unwritten", async () => {
    write("a.ts", disabled);
    write("clean.ts", "f();\n");
    const run = vi.fn<RunStryker>(() => {
      expect(read("clean.ts")).toBe("f();\n");
      writeReport([mutant("StringLiteral", "Survived")]);
      return Promise.resolve();
    });
    await checkDisables(["clean.ts", "a.ts"], dir, run, noInterrupt);
    expect(run).toHaveBeenCalledWith(["a.ts"], expect.any(AbortSignal));
  });

  test("runs nothing when no file holds a disable", async () => {
    write("clean.ts", "f();\n");
    const run = vi.fn<RunStryker>();
    await checkDisables(["clean.ts"], dir, run, noInterrupt);
    expect(run).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("No Stryker disable comments in clean.ts");
  });

  test("names a missing file and rewrites nothing", async () => {
    write("a.ts", disabled);
    const run = vi.fn<RunStryker>();
    await expect(checkDisables(["a.ts", "gone.ts"], dir, run, noInterrupt)).rejects.toThrow(
      "gone.ts",
    );
    expect(read("a.ts")).toBe(disabled);
    expect(run).not.toHaveBeenCalled();
  });

  test("restores the files when Stryker fails", async () => {
    write("a.ts", disabled);
    await expect(checkDisables(["a.ts"], dir, failing, noInterrupt)).rejects.toThrow(
      "Stryker failed",
    );
    expect(read("a.ts")).toBe(disabled);
  });

  test("restores the files and ignores the report of an earlier run when Stryker writes none", async () => {
    write("a.ts", disabled);
    writeReport([mutant("StringLiteral", "Survived")]);
    await expect(
      checkDisables(["a.ts"], dir, () => Promise.resolve(), noInterrupt),
    ).rejects.toThrow("mutation.json");
    expect(read("a.ts")).toBe(disabled);
    expect(console.log).not.toHaveBeenCalled();
  });

  test("keeps a file edited during the run and warns that its disables stay marked", async () => {
    write("a.ts", disabled);
    write("b.ts", disabled);
    const edited = `${marked}g();\n`;
    const run: RunStryker = () => {
      write("a.ts", edited);
      writeReport([mutant("StringLiteral", "Survived")]);
      return Promise.resolve();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkDisables(["a.ts", "b.ts"], dir, run, noInterrupt);
    expect(read("a.ts")).toBe(edited);
    expect(read("b.ts")).toBe(disabled);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a.ts changed during the run"));
  });

  test("the registered cleanup restores the files and stops Stryker", async () => {
    write("a.ts", disabled);
    const registered = Promise.withResolvers<() => Promise<void>>();
    const unregister = vi.fn<() => void>();
    const onInterrupt: OnInterrupt = (cleanup) => {
      registered.resolve(cleanup);
      return unregister;
    };
    const started = Promise.withResolvers<AbortSignal>();
    const run: RunStryker = (_files, signal) => {
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };

    const check = checkDisables(["a.ts"], dir, run, onInterrupt);
    check.catch(() => {});
    const interrupt = await registered.promise;
    const signal = await started.promise;
    expect(read("a.ts")).toBe(marked);

    await interrupt();

    expect(read("a.ts")).toBe(disabled);
    expect(signal.aborted).toBe(true);
    await expect(check).rejects.toThrow("aborted");
    expect(read("a.ts")).toBe(disabled);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});

describe("parseArgs", () => {
  test("splits the files --mutate names", () => {
    expect(parseArgs(["--mutate", "a.ts,src/b.ts"])).toEqual(["a.ts", "src/b.ts"]);
  });

  test.each([
    [[]],
    [["--mutate"]],
    [["a.ts"]],
    [["--mutate", ""]],
    [["--mutate", "a.ts,"]],
    [["--mutate", "--force"]],
    [["--mutate", "a.ts", "b.ts"]],
  ])("rejects %j", (args) => {
    expect(parseArgs(args)).toBeUndefined();
  });
});

describe("main", () => {
  test("prints the usage and fails on other arguments", async () => {
    await main([], dir);
    expect(console.error).toHaveBeenCalledWith("Usage: pnpm mutation:disables --mutate a.ts,b.ts");
    expect(process.exitCode).toBe(1);
  });

  test("names a failure and exits non-zero", async () => {
    await main(["--mutate", "gone.ts"], dir);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain("gone.ts");
    expect(process.exitCode).toBe(1);
  });

  test("checks the files it is given", async () => {
    write("clean.ts", "f();\n");
    await main(["--mutate", "clean.ts"], dir);
    expect(console.log).toHaveBeenCalledWith("No Stryker disable comments in clean.ts");
    expect(process.exitCode).toBeUndefined();
  });
});
