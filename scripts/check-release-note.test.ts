import { describe, expect, test } from "vitest";
import { checkReleaseNote, wantsChangedFiles } from "./check-release-note.ts";

const shippedCode = "src/runtime/query/from.ts";

describe("checkReleaseNote title", () => {
  test.each(["feat(tooling): x", "fix(tooling): x", "perf(tooling): x", "feat(tooling)!: x"])(
    "rejects %s without a diff",
    (title) => {
      expect(checkReleaseNote(title)).toEqual([
        `PR title "${title}" adds a release note for tooling: use chore(tooling)`,
      ]);
    },
  );

  test.each([
    "chore(tooling): x",
    "feat(queries): x",
    "feat: x",
    "docs(tooling): x",
    "not a title",
  ])("accepts %s without a diff", (title) => {
    expect(checkReleaseNote(title)).toEqual([]);
  });
});

describe("checkReleaseNote files", () => {
  test.each(["feat(lint): x", "fix(scripts): x", "perf: x", "fix(ci)!: x"])(
    "rejects %s that changes no shipped file",
    (title) => {
      const files = ["scripts/a.ts", "src/runtime/query/from.test.ts", "README.md"];
      expect(checkReleaseNote(title, files)).toEqual([
        `PR title "${title}" adds a release note, but the PR changes no shipped file: use chore, docs, test, or ci`,
      ]);
    },
  );

  test.each([shippedCode, "package.json", "tsdown.config.ts", "src/dev/cli/bin.ts"])(
    "accepts a feat that changes %s",
    (file) => {
      expect(checkReleaseNote("feat(queries): x", ["scripts/a.ts", file])).toEqual([]);
    },
  );

  test.each(["src/a.test.ts", "src/a.test-helper.ts", "xsrc/a.ts"])(
    "does not count %s as shipped",
    (file) => {
      expect(checkReleaseNote("fix: x", [file])).toHaveLength(1);
    },
  );

  test("leaves a title with no release note alone", () => {
    expect(checkReleaseNote("chore(deps): x", ["scripts/a.ts"])).toEqual([]);
  });

  test.each(["chore(tooling): x", "chore(tooling)!: x", "docs(tooling): x"])(
    "rejects %s that changes shipped code, naming it",
    (title) => {
      expect(checkReleaseNote(title, [shippedCode, "scripts/a.ts", "src/b.test.ts"])).toEqual([
        `PR title "${title}" says tooling, but the PR changes shipped code: ${shippedCode}`,
      ]);
    },
  );

  test("lets chore(tooling) edit package.json, tests, and scripts", () => {
    const files = ["package.json", "tsdown.config.ts", "src/a.test.ts", "scripts/a.ts"];
    expect(checkReleaseNote("chore(tooling): x", files)).toEqual([]);
  });

  test("reports feat(tooling) once when it changes no shipped file", () => {
    expect(checkReleaseNote("feat(tooling): x", ["scripts/a.ts"])).toEqual([
      'PR title "feat(tooling): x" adds a release note for tooling: use chore(tooling)',
    ]);
  });

  test("reports feat(tooling) twice when it changes shipped code", () => {
    expect(checkReleaseNote("feat(tooling): x", [shippedCode])).toEqual([
      'PR title "feat(tooling): x" adds a release note for tooling: use chore(tooling)',
      `PR title "feat(tooling): x" says tooling, but the PR changes shipped code: ${shippedCode}`,
    ]);
  });
});

describe("wantsChangedFiles", () => {
  test.each(["feat: x", "fix(cli): x", "perf(a)!: x", "chore(tooling): x", "docs(tooling): x"])(
    "reads the diff for %s",
    (title) => {
      expect(wantsChangedFiles(title)).toBe(true);
    },
  );

  test.each(["chore(deps): x", "docs(adr): propose x", "chore: x", "not a title"])(
    "skips the diff for %s",
    (title) => {
      expect(wantsChangedFiles(title)).toBe(false);
    },
  );
});
