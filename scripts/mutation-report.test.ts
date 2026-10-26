import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, reportBody, type Survivor, survivors } from "./mutation-report.ts";

type Mutant = { mutatorName: string; status: string; line: number };

function report(files: Record<string, Mutant[]>): unknown {
  return {
    schemaVersion: "1.0",
    files: Object.fromEntries(
      Object.entries(files).map(([file, mutants]) => [
        file,
        {
          language: "typescript",
          mutants: mutants.map(({ mutatorName, status, line }) => ({
            mutatorName,
            status,
            location: { start: { line, column: 1 }, end: { line, column: 9 } },
          })),
        },
      ]),
    ),
  };
}

const survivor = (file: string, line: number, mutator = "StringLiteral"): Survivor => ({
  file,
  line,
  mutator,
  status: "Survived",
});

describe("survivors", () => {
  test("keeps survived and uncovered mutants, sorted by file then line", () => {
    const parsed = report({
      "src/b.ts": [
        { mutatorName: "BlockStatement", status: "NoCoverage", line: 9 },
        { mutatorName: "StringLiteral", status: "Survived", line: 3 },
      ],
      "src/a.ts": [
        { mutatorName: "ConditionalExpression", status: "Survived", line: 12 },
        { mutatorName: "EqualityOperator", status: "Killed", line: 4 },
        { mutatorName: "ArithmeticOperator", status: "Timeout", line: 5 },
      ],
    });
    expect(survivors(parsed)).toEqual([
      { file: "src/a.ts", line: 12, mutator: "ConditionalExpression", status: "Survived" },
      { file: "src/b.ts", line: 3, mutator: "StringLiteral", status: "Survived" },
      { file: "src/b.ts", line: 9, mutator: "BlockStatement", status: "NoCoverage" },
    ]);
  });

  test("names the bad field in a malformed report", () => {
    expect(() =>
      survivors({ files: { "src/a.ts": { mutants: [{ status: "Survived" }] } } }),
    ).toThrow('$.files["src/a.ts"].mutants[0]');
  });
});

describe("reportBody", () => {
  test("lists each survivor as a table row", () => {
    const body = reportBody([survivor("src/a.ts", 3), survivor("src/b.ts", 7, "BlockStatement")]);
    expect(body).toContain("2 mutants");
    expect(body).toContain("| `src/a.ts` | 3 | StringLiteral | Survived |");
    expect(body).toContain("| `src/b.ts` | 7 | BlockStatement | Survived |");
  });

  test("counts the rows it leaves out past the length limit", () => {
    const list = [survivor("a.ts", 1), survivor("b.ts", 2), survivor("c.ts", 3)];
    const full = reportBody(list);
    const body = reportBody(list, full.length - 10);
    expect(body).toContain("3 mutants");
    expect(body).toContain("`b.ts`");
    expect(body).not.toContain("`c.ts`");
    expect(body).toContain("1 more not shown");
    expect(full).not.toContain("more not shown");
  });
});

const ghWithOpen = (...numbers: number[]) =>
  vi.fn<(args: string[], input?: string) => string>((args) =>
    args[1] === "list" ? JSON.stringify(numbers.map((number) => ({ number }))) : "",
  );

describe("main", () => {
  let dir: string;
  const env = { GITHUB_REPOSITORY: "smonn/db" };
  const write = (payload: unknown, name = "mutation.json"): string[] => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(payload));
    return [path];
  };
  const withSurvivor = (): string[] =>
    write(report({ "src/a.ts": [{ mutatorName: "StringLiteral", status: "Survived", line: 3 }] }));
  const clean = (): string[] =>
    write(report({ "src/a.ts": [{ mutatorName: "StringLiteral", status: "Killed", line: 3 }] }));
  const list = ["issue", "list", "--repo", "smonn/db", "--label", "mutation-report"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mutation-report-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("opens the report issue when none is open", () => {
    const gh = ghWithOpen();
    main(withSurvivor(), env, gh);
    expect(gh.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(list));
    expect(gh).toHaveBeenNthCalledWith(
      2,
      [
        "issue",
        "create",
        "--repo",
        "smonn/db",
        "--title",
        "Mutants survive the weekly Stryker run",
        "--label",
        "mutation-report",
        "--body-file",
        "-",
      ],
      expect.stringContaining("| `src/a.ts` | 3 | StringLiteral | Survived |"),
    );
    expect(gh).toHaveBeenCalledTimes(2);
  });

  test("rewrites the open report issue", () => {
    const gh = ghWithOpen(41);
    main(withSurvivor(), env, gh);
    expect(gh).toHaveBeenNthCalledWith(
      2,
      ["issue", "edit", "41", "--repo", "smonn/db", "--body-file", "-"],
      expect.stringContaining("`src/a.ts`"),
    );
    expect(gh).toHaveBeenCalledTimes(2);
  });

  test("closes the open report issue when nothing survives", () => {
    const gh = ghWithOpen(41);
    main(clean(), env, gh);
    expect(gh.mock.calls[1]?.[0]).toEqual([
      "issue",
      "close",
      "41",
      "--repo",
      "smonn/db",
      "--comment",
      "No mutants survive the latest Stryker run.",
    ]);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  test("does nothing when nothing survives and no issue is open", () => {
    const gh = ghWithOpen();
    main(clean(), env, gh);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  test("refuses to pick between several open report issues", () => {
    const gh = ghWithOpen(41, 52);
    expect(() => {
      main(withSurvivor(), env, gh);
    }).toThrow("#41, #52");
    expect(gh).toHaveBeenCalledTimes(1);
  });

  test("merges the survivors of every shard's report, by file", () => {
    const gh = ghWithOpen();
    const reports = [
      ...write(
        report({ "src/b.ts": [{ mutatorName: "A", status: "Survived", line: 1 }] }),
        "b.json",
      ),
      ...write(
        report({ "src/a.ts": [{ mutatorName: "B", status: "NoCoverage", line: 2 }] }),
        "a.json",
      ),
    ];
    main(reports, env, gh);
    expect(gh).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["create"]),
      expect.stringMatching(/2 mutants[\s\S]*`src\/a\.ts`[\s\S]*`src\/b\.ts`/u),
    );
  });

  test("fails without GITHUB_REPOSITORY", () => {
    const gh = ghWithOpen();
    main(withSurvivor(), {}, gh);
    expect(process.exitCode).toBe(1);
    expect(gh).not.toHaveBeenCalled();
  });
});
