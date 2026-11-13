import { afterEach, expect, test } from "vitest";
import { fakeSource, issue } from "./live-input-checks.test-helper.ts";
import { CHECKS } from "./live-input-checks.ts";
import { runProbe, type Check } from "./live-input-probe.ts";

afterEach(() => {
  process.exitCode = undefined;
});

const named = (name: string): Check => {
  const found = CHECKS.find((check) => check.name === name);
  if (found === undefined) throw new Error(`no check ${name}`);
  return found;
};

const results = (name: string, source: ReturnType<typeof fakeSource>) =>
  named(name)
    .probes(source)
    .map((probe) => runProbe(probe));

test("check:issue refuses an issue with no milestone, and sends nothing to GitHub", () => {
  const source = fakeSource({ issues: () => [issue(1), issue(2, { milestone: { number: 3 } })] });
  const [missing, fine] = results("check:issue", source);
  expect(missing).toMatchObject({ outcome: "refused", sample: "#1 Issue 1" });
  expect(missing?.lines).toEqual([
    expect.stringMatching(
      /^would run gh issue comment 1 --repo owner\/repo "This issue has no milestone/u,
    ),
    "would run gh issue edit 1 --repo owner/repo --add-label needs-triage",
  ]);
  expect(fine?.outcome).toBe("passed");
  expect(source.calls).toEqual([]);
});

test("check:issue refuses a lowercase title the same way", () => {
  const source = fakeSource({
    issues: () => [{ ...issue(1, { milestone: { number: 3 }, title: "generate drops tables" }) }],
  });
  expect(results("check:issue", source)[0]?.lines).toEqual([
    expect.stringContaining("This title starts with a lowercase letter"),
  ]);
});

const readyIssue = (labels: string[]) =>
  issue(5, { labels: labels.map((name) => ({ name })), milestone: { number: 3 } });

function labelsSource(labels: string[]) {
  const current = JSON.stringify({ ...readyIssue(labels).raw });
  return fakeSource({
    issues: () => [readyIssue(labels)],
    answers: {
      "repos/owner/repo/issues/5": current,
      "repos/owner/repo/issues/5/comments?per_page=100": "[[]]",
    },
  });
}

test("check:labels reads the issue and its comments, and records the comment it would post", () => {
  const source = labelsSource(["ready-for-agent"]);
  const [result] = results("check:labels", source);
  expect(result?.outcome).toBe("refused");
  expect(result?.lines).toEqual([
    expect.stringMatching(
      /^would run gh issue comment 5 --repo owner\/repo "<!-- smonn-db:ready-labels -->/u,
    ),
  ]);
  expect(source.calls.map((call) => call[0])).toEqual(["api", "api"]);
  expect(source.calls.flat()).not.toContain("comment");
});

test("check:labels passes a ready issue with both labels", () => {
  const source = labelsSource(["ready-for-agent", "priority:medium", "enhancement"]);
  expect(results("check:labels", source)[0]?.outcome).toBe("passed");
});

test("check:parent throws when the API leaves out a field the check needs", () => {
  const source = fakeSource({
    issues: () => [issue(7, { milestone: { number: 3 }, labels: [{ name: "area:tooling" }] })],
    answers: {
      "repos/owner/repo/issues/7": JSON.stringify({
        number: 7,
        state: "open",
        milestone: { number: 3 },
        labels: [{ name: "area:tooling" }],
        user: { type: "User" },
      }),
    },
  });
  const [result] = results("check:parent", source);
  expect(result).toMatchObject({
    outcome: "threw",
    lines: [expect.stringContaining("sub_issues_summary")],
  });
});

test("check:parent records the comment it would post, without waiting out its grace period", () => {
  const current = JSON.stringify({
    number: 7,
    state: "open",
    milestone: { number: 3 },
    labels: [{ name: "area:tooling" }],
    user: { type: "User" },
    sub_issues_summary: { total: 0 },
  });
  const parent = {
    number: 20,
    labels: [{ name: "area:tooling" }],
    sub_issues_summary: { total: 2 },
  };
  const source = fakeSource({
    issues: () => [issue(7, { milestone: { number: 3 }, labels: [{ name: "area:tooling" }] })],
    answers: {
      "repos/owner/repo/issues/7": current,
      "repos/owner/repo/issues/7/comments?per_page=100": "[[]]",
      "repos/owner/repo/issues?milestone=3&state=open&per_page=100": JSON.stringify([[parent]]),
    },
  });
  const [result] = results("check:parent", source);
  expect(result?.lines).toEqual([
    expect.stringMatching(/^would run gh issue comment 7 --repo owner\/repo ".*#20/u),
  ]);
});

const upstreamRaw = (overrides: Record<string, unknown> = {}) =>
  issue(9, {
    html_url: "https://github.com/owner/repo/issues/9",
    repository_url: "https://api.github.com/repos/owner/repo",
    body: null,
    comments: 0,
    ...overrides,
  });

test("check:upstream passes an issue that cites nothing", () => {
  expect(results("check:upstream", fakeSource({ issues: () => [upstreamRaw()] }))[0]?.outcome).toBe(
    "passed",
  );
});

test("check:upstream throws on an issue shaped unlike the API's", () => {
  const source = fakeSource({ issues: () => [issue(9)] });
  expect(results("check:upstream", source)[0]).toMatchObject({
    outcome: "threw",
    lines: [expect.stringContaining("html_url")],
  });
});
