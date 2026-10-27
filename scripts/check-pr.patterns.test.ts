import { describe, expect, test } from "vitest";
import { checkBranch, checkPr, parseAdrStatus, type ChangedAdr } from "./check-pr.ts";

describe("checkPr types", () => {
  test.each([
    "build",
    "chore",
    "ci",
    "docs",
    "feat",
    "fix",
    "perf",
    "refactor",
    "revert",
    "style",
    "test",
  ])("accepts the %s type", (type) => {
    expect(checkPr(`${type}(scope): summary`, "chore/x")).toEqual([]);
  });
});

describe("checkPr title anchoring", () => {
  test("rejects a title that only contains a Conventional Commit", () => {
    expect(checkPr("see feat: add where", "chore/x")).toHaveLength(1);
  });
});

describe("checkBranch anchoring", () => {
  test("rejects a Conventional Branch name nested under another folder", () => {
    expect(checkBranch("docs/feature/typed")).toHaveLength(1);
  });
});

describe("parseAdrStatus shapes", () => {
  test.each([
    ["# T\n---\nstatus: accepted\n---\n", "missing"],
    ["---\ntitle: x\n---\n\nstatus: accepted\n", "missing"],
    ["---\nnote status: accepted\n---\n", "missing"],
    ["---\nstatus: accepted soon\n---\n", "missing"],
    ["---\nstatus:accepted\n---\n", "accepted"],
    ["---\nstatus: accepted  \n---\n", "accepted"],
    ["---\ntitle: x\nstatus: proposed\n---\n", "proposed"],
  ])("reads %j as %s", (text, status) => {
    expect(parseAdrStatus(text)).toBe(status);
  });
});

describe("checkPr ADR title shapes", () => {
  const proposed: ChangedAdr = { file: "docs/adr/0001-a.md", status: "proposed", added: true };
  const superseded: ChangedAdr = { file: "docs/adr/0002-b.md", status: "superseded", added: false };

  test("names both problems for an accept title over changed ADRs that are none accepted", () => {
    expect(checkPr("docs(adr): accept x", "chore/x", [proposed])).toEqual([
      'PR title says "accept" but docs/adr/0001-a.md has status: proposed',
      'PR title says "accept" but no ADR became accepted',
    ]);
    expect(
      checkPr("docs(adr): accept x", "chore/x", [{ ...superseded, baseStatus: "accepted" }]),
    ).toEqual(['PR title says "accept" but no ADR became accepted']);
  });

  test("applies the ADR title rule only to a title that starts with docs(adr)", () => {
    expect(checkPr("feat: docs(adr): accept x", "chore/x", [proposed])).toEqual([]);
  });

  test("skips the ADR title check when no ADRs were read", () => {
    expect(checkPr("docs(adr): accept x", "chore/x")).toEqual([]);
  });
});
