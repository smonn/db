import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { findReferences, main } from "./check-closed-upstream.ts";
import {
  commentsPath,
  ghReplies,
  notFound,
  openIssues,
  recorded,
  recordedReplies,
  upstreamPath,
} from "./check-closed-upstream.test-helper.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const find = (text: string) => findReferences(text, "smonn/db");

describe("findReferences", () => {
  test("reads owner/repo#n and github.com issue and pull URLs, in order of appearance", () => {
    const text =
      "See https://github.com/pnpm/pnpm/pull/9 and porsager/postgres#1240, then nodejs/node#5.";
    expect(find(text)).toEqual([
      { repo: "pnpm/pnpm", number: 9 },
      { repo: "porsager/postgres", number: 1240 },
      { repo: "nodejs/node", number: 5 },
    ]);
  });

  test("lists a reference once however it is written", () => {
    const text =
      "porsager/postgres#1240 is https://github.com/porsager/postgres/pull/1240#issuecomment-1";
    expect(find(text)).toEqual([{ repo: "porsager/postgres", number: 1240 }]);
  });

  test("treats a repository name by its lower case", () => {
    expect(find("Porsager/Postgres#7 and porsager/postgres#7")).toHaveLength(1);
  });

  test("ignores the issue's own repository, however it is written", () => {
    const text = "smonn/db#5, SMONN/db#6, https://github.com/smonn/db/issues/7, and #8";
    expect(find(text)).toEqual([]);
  });

  test.each([
    ["a bare number", "see #12"],
    ["a longer word after the number", "porsager/postgres#12abc"],
    ["a path segment before the repository", "src/porsager/postgres#12"],
    [
      "a URL to something other than an issue or pull request",
      "https://github.com/pnpm/pnpm/releases/9",
    ],
  ])("ignores %s", (_name, text) => {
    expect(find(text)).toEqual([]);
  });
});

describe("main", () => {
  const spawn = vi.mocked(spawnSync);
  const own = "https://github.com/smonn/db/issues";
  const synthetic = (overrides: object) => ({
    number: 3,
    title: "Waiting",
    html_url: `${own}/3`,
    repository_url: "https://api.github.com/repos/smonn/db",
    body: null,
    comments: 0,
    ...overrides,
  });

  beforeEach(() => {
    spawn.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("lists each closed citation in the recorded open issues and fails", () => {
    ghReplies(spawn, recordedReplies());
    main();
    expect(console.log).toHaveBeenCalledWith(
      [
        `#699 cites porsager/postgres#1240, closed (https://github.com/porsager/postgres/pull/1240); cited in ${own}/699`,
        `#696 cites porsager/postgres#1199, closed (https://github.com/porsager/postgres/issues/1199); cited in ${own}/696`,
        `#614 cites porsager/postgres#1219, closed (https://github.com/porsager/postgres/issues/1219); cited in ${own}/614`,
        `#614 cites porsager/postgres#1220, closed (https://github.com/porsager/postgres/pull/1220); cited in ${own}/614`,
        `#364 cites porsager/postgres#1240, closed (https://github.com/porsager/postgres/pull/1240); cited in ${own}/364`,
        `#364 cites porsager/postgres#1199, closed (https://github.com/porsager/postgres/issues/1199); cited in ${own}/364#issuecomment-6538762784`,
      ].join("\n"),
    );
    expect(console.warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("reads the issue list with gh api, paginated and slurped", () => {
    ghReplies(spawn, recordedReplies());
    main();
    expect(spawn.mock.calls[0]).toEqual([
      "gh",
      ["api", "--paginate", "--slurp", openIssues],
      { encoding: "utf8" },
    ]);
  });

  test("looks each upstream up once, and reads comments only of an issue that has some", () => {
    ghReplies(spawn, recordedReplies());
    main();
    const paths = spawn.mock.calls.map(([, args]) => args?.at(-1));
    expect(paths.filter((path) => path === upstreamPath("porsager/postgres", 1240))).toHaveLength(
      1,
    );
    expect(spawn).toHaveBeenCalledWith("gh", ["api", upstreamPath("porsager/postgres", 1240)], {
      encoding: "utf8",
    });
    expect(paths).not.toContain(commentsPath(699));
    expect(paths).toContain(commentsPath(364));
  });

  test("skips a pull request: its upstream is never looked up", () => {
    ghReplies(spawn, recordedReplies());
    main();
    const paths = spawn.mock.calls.map(([, args]) => args?.at(-1));
    expect(paths).not.toContain(upstreamPath("pnpm/tasks", 224));
  });

  test("passes when every cited upstream is still open", () => {
    const open = recorded("porsager-postgres-1287");
    ghReplies(spawn, {
      ...recordedReplies(),
      ...Object.fromEntries(
        [1240, 1199, 1219, 1220].map((n) => [upstreamPath("porsager/postgres", n), open]),
      ),
    });
    main();
    expect(console.log).toHaveBeenCalledWith("No open issue cites a closed upstream issue.");
    expect(process.exitCode).toBeUndefined();
  });

  test("warns about a reference GitHub does not return, and does not fail on it", () => {
    ghReplies(spawn, {
      ...recordedReplies(),
      [upstreamPath("porsager/postgres", 1219)]: notFound,
    });
    main();
    expect(console.warn).toHaveBeenCalledWith(
      "warning: #614 cites porsager/postgres#1219, which GitHub does not return (404)",
    );
    expect(vi.mocked(console.log).mock.calls[0]?.[0]).not.toContain("#1219");
    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toContain(
      "#614 cites porsager/postgres#1220",
    );
  });

  test("fails on a gh error other than 404, naming the path and the error", () => {
    ghReplies(spawn, {
      ...recordedReplies(),
      [upstreamPath("porsager/postgres", 1240)]: {
        status: 1,
        stderr: "gh: rate limit (HTTP 403)\n",
      },
    });
    main();
    expect(console.error).toHaveBeenCalledWith(
      `gh api ${upstreamPath("porsager/postgres", 1240)} failed:\ngh: rate limit (HTTP 403)`,
    );
    expect(process.exitCode).toBe(1);
  });

  test("names the bad field of an upstream with an unknown state", () => {
    ghReplies(spawn, {
      ...recordedReplies(),
      [upstreamPath("porsager/postgres", 1240)]: '{"state":"merged","html_url":"x"}',
    });
    main();
    expect(console.error).toHaveBeenCalledWith('$.state: expected "open" | "closed", got string');
    expect(process.exitCode).toBe(1);
  });

  test("names the bad field of an issue in the list", () => {
    ghReplies(spawn, { [openIssues]: JSON.stringify([[{ number: "3" }]]) });
    main();
    expect(console.error).toHaveBeenCalledWith("$[0][0].number: expected number, got string");
  });

  test("names the source of text that is not JSON", () => {
    ghReplies(spawn, { ...recordedReplies(), [upstreamPath("porsager/postgres", 1240)]: "<html>" });
    main();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^gh api repos\/porsager\/postgres\/issues\/1240: invalid JSON \(.+\)$/u,
      ),
    );
    ghReplies(spawn, { [openIssues]: "<html>" });
    main();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^gh api repos\/\{owner\}\/\{repo\}\/issues\?.+: invalid JSON/u),
    );
  });

  describe("with a synthetic issue", () => {
    const upstream = "https://github.com/pnpm/pnpm/issues/9";

    test("reads an issue with no body as citing nothing", () => {
      ghReplies(spawn, { [openIssues]: JSON.stringify([[synthetic({})]]) });
      main();
      expect(console.log).toHaveBeenCalledWith("No open issue cites a closed upstream issue.");
    });

    test("names a reference once, where it first appears", () => {
      ghReplies(spawn, {
        [openIssues]: JSON.stringify([[synthetic({ body: `Waits on ${upstream}`, comments: 1 })]]),
        [commentsPath(3)]: JSON.stringify([
          [{ html_url: `${own}/3#issuecomment-1`, body: "Still waiting on pnpm/pnpm#9" }],
        ]),
        [upstreamPath("pnpm/pnpm", 9)]: JSON.stringify({ state: "closed", html_url: upstream }),
      });
      main();
      expect(console.log).toHaveBeenCalledWith(
        `#3 cites pnpm/pnpm#9, closed (${upstream}); cited in ${own}/3`,
      );
    });

    test("reads an http github.com URL", () => {
      ghReplies(spawn, {
        [openIssues]: JSON.stringify([[synthetic({ body: "http://github.com/pnpm/pnpm/pull/9" })]]),
        [upstreamPath("pnpm/pnpm", 9)]: JSON.stringify({ state: "closed", html_url: upstream }),
      });
      main();
      expect(process.exitCode).toBe(1);
    });
  });
});
