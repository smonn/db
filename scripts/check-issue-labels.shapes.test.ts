import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MARKER, main } from "./check-issue-labels.ts";
import {
  comment,
  commentsRoute,
  event,
  fakeGh,
  fetched,
  issueRoute,
  labelled,
  run,
  writeEvent,
} from "./check-issue-labels.test-helper.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn<typeof execFileSync>() }));

const missingPriority = fetched({ labels: labelled("ready-for-agent", "bug") });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("the marker", () => {
  test("stays the string already posted on issues", () => {
    expect(MARKER).toBe("<!-- smonn-db:ready-labels -->");
  });
});

describe("reads of the API", () => {
  test("ask gh for the issue, then its comments, then post", () => {
    const gh = run(event(missingPriority));
    expect(gh.mock.calls.map(([args]) => args)).toEqual([
      ["api", issueRoute],
      ["api", "--paginate", "--slurp", commentsRoute],
      comment("no `priority:*` label"),
    ]);
  });

  test("name the request when gh does not answer with JSON", () => {
    const path = writeEvent(event(missingPriority));
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, fakeGh({}));
    }).toThrow(`gh api ${issueRoute}: invalid JSON`);
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, fakeGh({ [issueRoute]: missingPriority }));
    }).toThrow(`gh api ${commentsRoute}: invalid JSON`);
  });

  test("name the field when the issue or its comments have the wrong shape", () => {
    const path = writeEvent(event(missingPriority));
    expect(() => {
      main(
        { GITHUB_EVENT_PATH: path },
        fakeGh({ [issueRoute]: { ...missingPriority, number: "7" } }),
      );
    }).toThrow("$.number: expected number");
    expect(() => {
      main(
        { GITHUB_EVENT_PATH: path },
        fakeGh({ [issueRoute]: missingPriority, [commentsRoute]: [[{ body: 5 }]] }),
      );
    }).toThrow("$[0][0].body: expected string");
  });

  test("name the repository when the event's repository has no name", () => {
    const path = writeEvent(
      { ...event(missingPriority), repository: { full_name: 5 } },
      "bad.json",
    );
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, fakeGh({}));
    }).toThrow("$.repository.full_name: expected string, got number");
  });
});

describe("main with the default gh", () => {
  test("runs gh for UTF-8 output", () => {
    const routes: Record<string, unknown> = {
      [issueRoute]: missingPriority,
      [commentsRoute]: [[]],
    };
    vi.mocked(execFileSync).mockImplementation((_command, args) =>
      JSON.stringify(routes[String(args?.at(-1))]),
    );
    main({ GITHUB_EVENT_PATH: writeEvent(event(missingPriority)) });
    expect(execFileSync).toHaveBeenCalledWith("gh", ["api", issueRoute], { encoding: "utf8" });
    expect(execFileSync).toHaveBeenLastCalledWith("gh", comment("no `priority:*` label"), {
      encoding: "utf8",
    });
  });
});
