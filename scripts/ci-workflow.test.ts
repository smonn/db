import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const bodyEdit =
  "github.event.action == 'edited' && !github.event.changes.title && !github.event.changes.base";

const jobs = ci
  .slice(ci.indexOf("\njobs:\n"))
  .split(/\n {2}(?=[a-z-]+:\n)/u)
  .slice(1);

test("ci.yml has jobs to check", () => {
  expect(jobs.length).toBeGreaterThanOrEqual(7);
});

test("every ci.yml job skips on a body-only PR edit", () => {
  const ungated = jobs.filter((job) => !job.includes(`!(${bodyEdit})`));
  expect(ungated.map((job) => job.split(":")[0])).toEqual([]);
});

test("every ci.yml job renames itself on a body-only PR edit, so a skipped check can't mask a real one", () => {
  const renamed = `name: "[^\\n]*\\$\\{\\{ ${bodyEdit} && ' \\(body edit\\)' \\|\\| '' \\}\\}"`;
  const unrenamed = jobs.filter((job) => !new RegExp(renamed, "u").test(job));
  expect(unrenamed.map((job) => job.split(":")[0])).toEqual([]);
});

test("a body-only PR edit gets its own concurrency group, so it can't cancel a running CI", () => {
  const concurrency = ci.slice(ci.indexOf("\nconcurrency:"), ci.indexOf("\njobs:"));
  expect(concurrency).toContain(`${bodyEdit} && 'body-edit' || 'ci'`);
});
