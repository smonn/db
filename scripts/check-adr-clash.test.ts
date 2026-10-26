import { describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { checkAdrClash, readOpenPrAdds, type OpenPrAdd } from "./check-adr-clash.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn<typeof execFileSync>() }));

const added = (file: string): { file: string; added: boolean } => ({ file, added: true });

describe("checkAdrClash", () => {
  const others: OpenPrAdd[] = [
    { pr: 424, file: "docs/adr/0023-schema-tool.md" },
    { pr: 425, file: "docs/adr/0024-other.md" },
  ];

  test("names the other PR and its file when the numbers match, whatever the slug", () => {
    expect(checkAdrClash([added("docs/adr/0023-drift.md")], others)).toEqual([
      "docs/adr/0023-drift.md reuses ADR number 0023, which open PR #424 adds as docs/adr/0023-schema-tool.md",
    ]);
  });

  test("names every PR that adds the number", () => {
    const both = [...others, { pr: 430, file: "docs/adr/0023-third.md" }];
    expect(checkAdrClash([added("docs/adr/0023-drift.md")], both)).toHaveLength(2);
  });

  test("passes a number no other PR adds", () => {
    expect(checkAdrClash([added("docs/adr/0025-new.md")], others)).toEqual([]);
  });

  test("ignores an ADR the PR only edits", () => {
    const edited = { file: "docs/adr/0023-drift.md", status: "accepted", added: false };
    expect(checkAdrClash([edited], others)).toEqual([]);
  });
});

describe("readOpenPrAdds", () => {
  const prs = [
    {
      number: 424,
      files: [
        { path: "docs/adr/0023-a.md", changeType: "ADDED" },
        { path: "docs/adr/0010-old.md", changeType: "MODIFIED" },
        { path: "docs/adr/TEMPLATE.md", changeType: "ADDED" },
        { path: "src/x.ts", changeType: "ADDED" },
      ],
    },
    { number: 500, files: [{ path: "docs/adr/0023-b.md", changeType: "ADDED" }] },
  ];

  test("lists the ADRs other open PRs add, leaving out the named PR", () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(prs));
    expect(readOpenPrAdds("500", "/repo")).toEqual([{ pr: 424, file: "docs/adr/0023-a.md" }]);
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,files"],
      { cwd: "/repo", encoding: "utf8" },
    );
  });
});
