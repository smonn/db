import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenPrAdd } from "./check-adr-clash.ts";
import { checkPr, main, parseAdrStatus, type ChangedAdr } from "./check-pr.ts";

describe("checkPr title", () => {
  const branch = "chore/53-pr-title-check";

  test.each([
    "feat: add where",
    "fix(diff): order drops before creates",
    "build(deps): update dependency oxlint to v1.90.0",
    "chore(main): release 0.1.0",
    "feat(cli)!: rename generate",
  ])("accepts %s", (title) => {
    expect(checkPr(title, branch)).toEqual([]);
  });

  test.each([
    "add where",
    "feature: add where",
    "Feat: add where",
    "feat:add where",
    "feat: ",
    "feat(): add where",
    "feat(cli) : add where",
  ])("rejects %s", (title) => {
    expect(checkPr(title, branch)).toEqual([
      `PR title "${title}" is not a Conventional Commit: type(scope): summary`,
    ]);
  });
});

describe("checkPr branch", () => {
  const title = "feat: add where";

  test.each([
    "feature/57-typed-query",
    "bugfix/diff-drop-order",
    "hotfix/1.2.1",
    "release/v0.1.0",
    "chore/area-labels",
    "renovate/devdependencies-(non-major)",
    "release-please--branches--main",
  ])("accepts %s", (branch) => {
    expect(checkPr(title, branch)).toEqual([]);
  });

  test.each([
    "docs/config-and-cli",
    "claude/typed-query",
    "feature/Typed-Query",
    "feature/typed_query",
    "feature/",
    "feature/-typed",
    "feature/typed-",
    "feature/typed--query",
    "feature/typed/query",
    "research/pg-depend-scan",
    "prototype/foreign-keys",
    "main",
  ])("rejects %s", (branch) => {
    expect(checkPr(title, branch)).toEqual([
      `Branch "${branch}" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>`,
    ]);
  });

  test("still checks the title on a bot branch", () => {
    expect(checkPr("Update oxlint", "renovate/oxlint-1.x")).toEqual([
      'PR title "Update oxlint" is not a Conventional Commit: type(scope): summary',
    ]);
  });

  test("reports a bad title and a bad branch together", () => {
    expect(checkPr("add where", "main")).toHaveLength(2);
  });
});

describe("parseAdrStatus", () => {
  test.each([
    ["---\nstatus: accepted\n---\n\n# T\n", "accepted"],
    ["---\nstatus: proposed\n---\n", "proposed"],
    ["# T\n\nstatus: accepted\n", "missing"],
    ["---\n---\n", "missing"],
  ])("reads %j as %s", (text, status) => {
    expect(parseAdrStatus(text)).toBe(status);
  });
});

const changed = (file: string, status: string, baseStatus: string): ChangedAdr => ({
  file: `docs/adr/${file}.md`,
  status,
  added: false,
  baseStatus,
});
describe("checkPr ADR title", () => {
  const branch = "chore/adr-title";
  const editsAccepted = changed("0021-indexes", "accepted", "accepted");
  const acceptsProposed = changed("0022-keys", "accepted", "proposed");
  const addsProposed = { file: "docs/adr/0026-new.md", status: "proposed", added: true };
  const addsAccepted = { file: "docs/adr/0027-new.md", status: "accepted", added: true };
  const editsProposed = changed("0028-draft", "proposed", "proposed");
  const supersedes = changed("0010-old", "superseded", "accepted");

  test.each([
    ["accepts a proposed ADR", acceptsProposed],
    ["adds an accepted ADR", addsAccepted],
  ])("rejects a propose title over a PR that %s, naming the file and status", (_name, adr) => {
    expect(checkPr("docs(adr): propose indexes", branch, [adr])).toEqual([
      `PR title says "propose" but ${adr.file} has status: accepted`,
    ]);
  });

  test("rejects an accept title over an ADR added as proposed", () => {
    expect(checkPr("docs(adr): accept indexes", branch, [acceptsProposed, addsProposed])).toEqual([
      'PR title says "accept" but docs/adr/0026-new.md has status: proposed',
    ]);
  });

  test("rejects an accept title when no ADR became accepted", () => {
    expect(checkPr("docs(adr): accept indexes", branch, [editsAccepted, editsProposed])).toEqual([
      'PR title says "accept" but no ADR became accepted',
    ]);
    expect(checkPr("docs(adr): accept indexes", branch, [])).toEqual([
      'PR title says "accept" but no ADR became accepted',
    ]);
  });

  test.each([
    ["docs(adr): propose indexes", [addsProposed, editsAccepted]],
    ["docs(adr): propose indexes", [editsAccepted, supersedes]],
    ["docs(adr): accept indexes", [acceptsProposed, supersedes]],
    ["docs(adr): accept indexes", [addsAccepted, editsProposed]],
    ["docs(adr)!: accept indexes", [acceptsProposed]],
  ])("accepts %s over matching ADRs", (title, adrs) => {
    expect(checkPr(title, branch, adrs)).toEqual([]);
  });

  test.each([
    "docs(adr): revise indexes",
    "docs(adr): accepted indexes",
    "docs(adr): proposed indexes",
    "docs: propose indexes",
    "feat(adr): accept indexes",
  ])("leaves %s unchecked", (title) => {
    expect(checkPr(title, branch, [editsAccepted, addsProposed])).toEqual([]);
  });
});

const addsAdr0023 = (): ChangedAdr[] => [
  { file: "docs/adr/0023-x.md", status: "proposed", added: true },
];

describe("main", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("passes a conforming title and branch", () => {
    main({ PR_TITLE: "feat: add where", PR_BRANCH: "feature/where" });
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("prints each problem and fails", () => {
    main({ PR_TITLE: "add where", PR_BRANCH: "main" });
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  test("checks the ADRs changed since PR_DIFF_BASE", () => {
    const readAdrs = vi.fn<(base: string) => ChangedAdr[]>(() => [
      { file: "docs/adr/0021-x.md", status: "accepted", added: true },
    ]);
    main(
      { PR_TITLE: "docs(adr): propose x", PR_BRANCH: "chore/x", PR_DIFF_BASE: "HEAD^1" },
      readAdrs,
    );
    expect(readAdrs).toHaveBeenCalledWith("HEAD^1");
    expect(console.error).toHaveBeenCalledWith(
      'PR title says "propose" but docs/adr/0021-x.md has status: accepted',
    );
    expect(process.exitCode).toBe(1);
  });

  describe("with PR_NUMBER", () => {
    const env = {
      PR_TITLE: "docs(adr): propose x",
      PR_BRANCH: "chore/x",
      PR_DIFF_BASE: "HEAD^1",
      PR_NUMBER: "426",
    };
    test("fails when another open PR adds the same ADR number", () => {
      const readOpenAdds = vi.fn<(exclude: string) => OpenPrAdd[]>(() => [
        { pr: 424, file: "docs/adr/0023-y.md" },
      ]);
      main(env, addsAdr0023, readOpenAdds);
      expect(readOpenAdds).toHaveBeenCalledWith("426");
      expect(console.error).toHaveBeenCalledWith(
        "docs/adr/0023-x.md reuses ADR number 0023, which open PR #424 adds as docs/adr/0023-y.md",
      );
      expect(process.exitCode).toBe(1);
    });

    test("passes when no other open PR adds the number", () => {
      main(env, addsAdr0023, () => []);
      expect(console.error).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    test("does not list open PRs when the PR adds no ADR", () => {
      const readOpenAdds = vi.fn<(exclude: string) => OpenPrAdd[]>(() => []);
      main(
        env,
        () => [{ file: "docs/adr/0021-x.md", status: "proposed", added: false }],
        readOpenAdds,
      );
      expect(readOpenAdds).not.toHaveBeenCalled();
    });

    test("does not list open PRs without PR_NUMBER", () => {
      const readOpenAdds = vi.fn<(exclude: string) => OpenPrAdd[]>(() => []);
      main({ ...env, PR_NUMBER: undefined }, addsAdr0023, readOpenAdds);
      expect(readOpenAdds).not.toHaveBeenCalled();
    });
  });

  test("skips the ADR check without PR_DIFF_BASE", () => {
    const readAdrs = vi.fn<(base: string) => ChangedAdr[]>(() => []);
    main({ PR_TITLE: "docs(adr): propose x", PR_BRANCH: "chore/x" }, readAdrs);
    expect(readAdrs).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("fails when PR_TITLE or PR_BRANCH is unset", () => {
    main({ PR_TITLE: "feat: add where" });
    expect(console.error).toHaveBeenCalledWith("Set PR_TITLE and PR_BRANCH");
    expect(process.exitCode).toBe(1);
  });
});
