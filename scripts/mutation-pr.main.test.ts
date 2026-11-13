import { expect, test, vi } from "vitest";
import { type Deps, header, main } from "./mutation-pr.ts";

const diff = ["+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");

const report = {
  files: {
    "src/a.ts": {
      source: "x",
      mutants: [
        { mutatorName: "StringLiteral", status: "Survived", location: { start: { line: 1 } } },
        { mutatorName: "StringLiteral", status: "Survived", location: { start: { line: 5 } } },
      ],
    },
  },
};

function deps(overrides: Partial<Deps> = {}): Deps & { written: string[] } {
  const written: string[] = [];
  const clock = [1000, 4000];
  return {
    git: vi.fn<Deps["git"]>((args) =>
      args.includes("--name-only") ? "src/a.ts\nREADME.md\n" : diff,
    ),
    mutable: () => ["src/a.ts", "src/b.ts"],
    stryker: vi.fn<Deps["stryker"]>(),
    report: () => report,
    now: () => clock.shift() ?? 0,
    write: (text) => {
      written.push(text);
    },
    ...overrides,
    written,
  };
}

test("says no mutable file changed, and runs no Stryker", () => {
  const d = deps({ git: () => "README.md\n" });
  main({}, d);
  expect(d.written).toEqual(["No mutable files changed.\n"]);
  expect(d.stryker).not.toHaveBeenCalled();
});

test("runs Stryker on the changed mutable files and summarizes by changed line", () => {
  const d = deps();
  main({}, d);
  expect(d.stryker).toHaveBeenCalledExactlyOnceWith(["src/a.ts"]);
  const text = d.written.join("");
  expect(text).toContain("### Survivors on lines this PR changed (1)");
  expect(text).toContain("| `src/a.ts` | 1 |");
  expect(text).toContain("### Other survivors in the changed files (1)");
  expect(text).toContain("| `src/a.ts` | 5 |");
  expect(text).toContain("Run time: 3s");
});

test("diffs HEAD^1 against HEAD unless PR_DIFF_BASE says otherwise", () => {
  const d = deps();
  main({}, d);
  expect(d.git).toHaveBeenNthCalledWith(1, [
    "diff",
    "--name-only",
    "--diff-filter=d",
    "HEAD^1",
    "HEAD",
  ]);
  expect(d.git).toHaveBeenNthCalledWith(2, ["diff", "--unified=0", "--no-color", "HEAD^1", "HEAD"]);
  const other = deps();
  main({ PR_DIFF_BASE: "abc123" }, other);
  expect(other.git).toHaveBeenNthCalledWith(1, [
    "diff",
    "--name-only",
    "--diff-filter=d",
    "abc123",
    "HEAD",
  ]);
});

test("writes the header before Stryker starts, so a job timeout still shows the files", () => {
  const seen: string[][] = [];
  const d = deps({
    stryker: () => {
      seen.push([...d.written]);
    },
  });
  main({}, d);
  expect(seen).toEqual([[header(["src/a.ts"])]]);
});

test("lets a Stryker failure through, after writing how long it ran", () => {
  const d = deps({
    stryker: () => {
      throw new Error("stryker failed");
    },
  });
  expect(() => {
    main({}, d);
  }).toThrow("stryker failed");
  expect(d.written).toEqual([header(["src/a.ts"]), "\nStryker failed after 3s.\n"]);
});
