import { afterEach, expect, test, vi } from "vitest";
import { main, selectChecks, summary, type Deps } from "./live-input-checks.ts";
import {
  captureRefusals,
  readOnlyGh,
  runProbe,
  type Check,
  type Probe,
  type Result,
} from "./live-input-probe.ts";
import { fakeSource } from "./live-input-checks.test-helper.ts";

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const probe = (run: () => string[]): Probe => ({ check: "check:x", sample: "#1", run });

test("a probe that returns nothing passed", () => {
  expect(runProbe(probe(() => []))).toEqual({
    check: "check:x",
    sample: "#1",
    outcome: "passed",
    lines: [],
  });
});

test("a probe that returns lines was refused, with those lines", () => {
  expect(runProbe(probe(() => ["no milestone"]))).toMatchObject({
    outcome: "refused",
    lines: ["no milestone"],
  });
});

test("a probe that throws threw, with the message", () => {
  const result = runProbe(
    probe(() => {
      throw new Error("$.sub_issues_summary: expected object, got undefined");
    }),
  );
  expect(result).toMatchObject({
    outcome: "threw",
    lines: ["$.sub_issues_summary: expected object, got undefined"],
  });
});

test("readOnlyGh runs a GET, with the paging flags", () => {
  const read = vi.fn<(args: string[]) => string>(() => "body");
  const writes: string[] = [];
  const gh = readOnlyGh(read, writes);
  expect(gh(["api", "repos/o/r/issues/1"])).toBe("body");
  expect(gh(["api", "--paginate", "--slurp", "repos/o/r/issues"])).toBe("body");
  expect(read).toHaveBeenCalledTimes(2);
  expect(writes).toEqual([]);
});

test.each([
  [["api", "-X", "DELETE", "repos/o/r/issues/comments/1"]],
  [["api", "--method", "POST", "repos/o/r/issues/1/comments"]],
  [["api", "-f", "body=x", "repos/o/r/issues/1/comments"]],
  [["api", "--input", "-", "repos/o/r/issues/1/comments"]],
  [["issue", "edit", "1", "--add-label", "needs-triage"]],
  [["pr", "list"]],
])("readOnlyGh sends %j nowhere and records it", (args) => {
  const read = vi.fn<(args: string[]) => string>(() => "body");
  const writes: string[] = [];
  expect(readOnlyGh(read, writes)(args)).toBe("");
  expect(read).not.toHaveBeenCalled();
  expect(writes).toEqual([`would run gh ${args.join(" ")}`]);
});

test("readOnlyGh quotes a comment body on one line, cut to 200 characters", () => {
  const writes: string[] = [];
  const body = `first\nsecond ${"x".repeat(300)}`;
  readOnlyGh(
    vi.fn<(args: string[]) => string>(),
    writes,
  )(["issue", "comment", "1", "--body", body, "--repo", "o/r"]);
  expect(writes).toEqual([
    `would run gh issue comment 1 --repo o/r "${`first second ${"x".repeat(300)}`.slice(0, 200)}"`,
  ]);
});

test("captureRefusals returns what the check wrote with console.error, then restores both", () => {
  const before = console.error;
  const lines = captureRefusals(() => {
    console.error("one");
    console.error("two", 2);
    process.exitCode = 1;
  });
  expect(lines).toEqual(["one", "two 2"]);
  expect(console.error).toBe(before);
  expect(process.exitCode).toBeUndefined();
});

const noop = (): void => {
  // Writes nothing and sets no exit code.
};

test("captureRefusals names an exit code that came with no message", () => {
  expect(
    captureRefusals(() => {
      process.exitCode = 2;
    }),
  ).toEqual(["exited with code 2"]);
});

test("captureRefusals returns nothing for a check that wrote nothing", () => {
  expect(captureRefusals(noop)).toEqual([]);
  process.exitCode = 0;
  expect(captureRefusals(noop)).toEqual([]);
});

test("captureRefusals restores console.error and the exit code when the check throws", () => {
  const before = console.error;
  process.exitCode = 3;
  expect(() =>
    captureRefusals(() => {
      process.exitCode = 1;
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(console.error).toBe(before);
  expect(process.exitCode).toBe(3);
});

const check = (name: string, files: string[], probes: Probe[] = []): Check => ({
  name,
  files,
  probes: () => probes,
});

test("selectChecks keeps the checks whose files changed", () => {
  const checks = [check("a", ["scripts/a.ts"]), check("b", ["scripts/b.ts", "scripts/shared.ts"])];
  expect(selectChecks(["README.md", "scripts/shared.ts"], checks).map((c) => c.name)).toEqual([
    "b",
  ]);
  expect(selectChecks(["README.md"], checks)).toEqual([]);
});

test.each([
  ["scripts/live-input-checks.ts"],
  ["scripts/live-input-source.ts"],
  [".github/workflows/live-input-checks.yml"],
])("selectChecks runs every check when %s changed", (file) => {
  const checks = [check("a", ["scripts/a.ts"]), check("b", ["scripts/b.ts"])];
  expect(selectChecks([file], checks)).toEqual(checks);
});

const results: Result[] = [
  { check: "check:x", sample: "#1 One", outcome: "passed", lines: [] },
  { check: "check:x", sample: "#2 Two", outcome: "refused", lines: ["no milestone"] },
  { check: "check:x", sample: "#3 Three", outcome: "threw", lines: ["bad shape"] },
  { check: "check:y", sample: "#1 One", outcome: "passed", lines: [] },
];

test("summary counts each outcome per check", () => {
  const text = summary([check("check:x", []), check("check:y", [])], results);
  expect(text).toContain("| `check:x` | 3 | 1 | 1 | 1 |");
  expect(text).toContain("| `check:y` | 1 | 1 | 0 | 0 |");
});

test("summary lists the threw and refused samples under their own headings", () => {
  const text = summary([check("check:x", [])], results);
  expect(text).toContain(
    "### Threw (fails the job) (1)\n\n- `check:x` on #3 Three\n  - bad shape\n",
  );
  expect(text).toContain(
    "### Refused (for the reviewer to judge) (1)\n\n- `check:x` on #2 Two\n  - no milestone\n",
  );
  expect(text).not.toContain("#1 One\n  -");
});

test("summary has no listing when every sample passed", () => {
  const text = summary([check("check:x", [])], [results[0]!]);
  expect(text).not.toContain("###");
});

test("summary caps a listing at 100 samples and says how many it hid", () => {
  const many: Result[] = Array.from({ length: 103 }, (_, index) => ({
    check: "check:x",
    sample: `#${index}`,
    outcome: "refused",
    lines: ["no"],
  }));
  const text = summary([check("check:x", [])], many);
  expect(text).toContain("### Refused (for the reviewer to judge) (103)");
  expect(text).toContain("- `check:x` on #99\n");
  expect(text).not.toContain("- `check:x` on #100\n");
  expect(text).toContain("3 more not shown.");
});

function deps(changed: string, source = fakeSource()): Deps & { written: string[] } {
  const written: string[] = [];
  return {
    git: vi.fn<Deps["git"]>(() => changed),
    source: () => source,
    write: (text) => {
      written.push(text);
    },
    written,
  };
}

test("main says so and reads no sample when no live-input check changed", () => {
  const source = fakeSource();
  const read = vi.fn<Deps["source"]>(() => source);
  const d = { ...deps("README.md\n"), source: read };
  main({}, d, [check("check:x", ["scripts/x.ts"], [probe(() => [])])]);
  expect(d.written).toEqual(["No check that reads live input changed.\n"]);
  expect(read).not.toHaveBeenCalled();
});

test("main diffs the base the env names against HEAD, defaulting to HEAD^1", () => {
  const first = deps("README.md\n");
  main({}, first, []);
  expect(first.git).toHaveBeenCalledWith(["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"]);
  const second = deps("README.md\n");
  main({ PR_DIFF_BASE: "origin/main" }, second, []);
  expect(second.git).toHaveBeenCalledWith([
    "diff",
    "--name-only",
    "--no-renames",
    "origin/main",
    "HEAD",
  ]);
});

test("main passes when a check only refuses a sample, and lists it", () => {
  const source = fakeSource();
  const d = deps("scripts/x.ts\n", source);
  main({}, d, [check("check:x", ["scripts/x.ts"], [probe(() => ["no milestone"])])]);
  expect(process.exitCode).toBeUndefined();
  expect(d.written.join("")).toContain("### Refused (for the reviewer to judge) (1)");
  expect(source.closed).toBe(true);
});

test("main fails the job when a check throws on one sample, and still runs and reports the rest", () => {
  const source = fakeSource();
  const d = deps("scripts/x.ts\n", source);
  const throwing = probe(() => {
    throw new Error("$.parent_issue_url: expected string, got undefined");
  });
  const after = vi.fn<() => string[]>(() => ["no milestone"]);
  main({}, d, [check("check:x", ["scripts/x.ts"], [probe(() => []), throwing, probe(after)])]);
  expect(process.exitCode).toBe(1);
  expect(after).toHaveBeenCalledOnce();
  const text = d.written.join("");
  expect(text).toContain("| `check:x` | 3 | 1 | 1 | 1 |");
  expect(text).toContain("$.parent_issue_url: expected string, got undefined");
  expect(source.closed).toBe(true);
});

test("main closes the source and rethrows when a check cannot list its samples", () => {
  const source = fakeSource();
  const d = deps("scripts/x.ts\n", source);
  const broken: Check = {
    name: "check:x",
    files: ["scripts/x.ts"],
    probes: () => {
      throw new Error("gh api failed");
    },
  };
  expect(() => {
    main({}, d, [broken]);
  }).toThrow("gh api failed");
  expect(source.closed).toBe(true);
});
