/**
 * Checks that a workflow job holding `id-token: write` runs no dependency code. npm trusted
 * publishing trades that token for a publish token, so an install script, a build, or a checked-out
 * repo hook in the same job could publish under the package's name. Such a job may only use
 * actions/download-artifact and pnpm/setup (with `install: false`), and its only `run:` steps are a
 * one-line `pnpm publish` or `pnpm stage publish` with `--ignore-scripts`. The workflow may not
 * grant id-token outside a job. Reads the YAML by indentation, as oxfmt formats it, rather than
 * parsing it, to avoid a YAML dependency. Prints each problem and exits 1.
 *
 * Run from the repo root with `pnpm check:oidc`; CI runs it in the Lint job.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowedActions = ["actions/download-artifact", "pnpm/setup"];
const publishCommand = /^pnpm (?:stage )?publish(?: [\w./=@:-]+)+$/u;
const grantsIdToken = /^\s*id-token:\s*write\s*$/mu;
const grantsAll = /^\s*permissions:\s*write-all\s*$/mu;

type Job = { name: string; body: string };

function splitJobs(workflow: string): { header: string; jobs: Job[] } {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (start === -1) return { header: workflow, jobs: [] };
  const header = lines.slice(0, start);
  const jobs: Job[] = [];
  for (const line of lines.slice(start + 1)) {
    const name = /^ {2}([\w-]+):\s*$/u.exec(line)?.[1];
    if (name !== undefined) jobs.push({ name, body: "" });
    else if (/^\S/u.test(line)) header.push(line);
    else {
      const job = jobs.at(-1);
      if (job !== undefined) job.body += `${line}\n`;
    }
  }
  return { header: header.join("\n"), jobs };
}

function splitSteps(body: string): string[] {
  const steps: string[] = [];
  for (const line of body.split("\n")) {
    if (/^ {6}- /u.test(line)) steps.push(`${line}\n`);
    else if (steps.length > 0 && /^ {7,}\S/u.test(line)) steps[steps.length - 1] += `${line}\n`;
  }
  return steps;
}

function checkStep(step: string, where: string): string[] {
  const action = /^\s*-?\s*uses:\s*([^@\s]+)@/mu.exec(step)?.[1];
  if (action !== undefined && !allowedActions.includes(action))
    return [`${where} uses ${action}; allowed: ${allowedActions.join(", ")}`];
  if (action === "pnpm/setup" && !/^\s*install:\s*false\s*$/mu.test(step))
    return [`${where} runs pnpm/setup without install: false`];
  const run = /^\s*-?\s*run:\s*(.*?)\s*$/mu.exec(step)?.[1];
  if (
    run !== undefined &&
    !(publishCommand.test(run) && run.split(" ").includes("--ignore-scripts"))
  )
    return [
      `${where} runs "${run}"; allowed: pnpm publish or pnpm stage publish with --ignore-scripts`,
    ];
  return [];
}

export function checkOidcJobs(workflow: string, file: string): string[] {
  const { header, jobs } = splitJobs(workflow);
  const problems: string[] = [];
  if (grantsIdToken.test(header) || grantsAll.test(header))
    problems.push(`${file} grants id-token outside a job; grant it to the publish job only`);
  for (const job of jobs) {
    const all = grantsAll.test(job.body);
    if (all) problems.push(`${file} job ${job.name} grants write-all, which includes id-token`);
    if (!all && !grantsIdToken.test(job.body)) continue;
    const where = `${file} job ${job.name} holds id-token and`;
    const steps = splitSteps(job.body);
    if (steps.length === 0) problems.push(`${where} has no steps at six-space indent to check`);
    for (const step of steps) problems.push(...checkStep(step, where));
  }
  return problems;
}

export function main(cwd = "."): void {
  const dir = join(cwd, ".github", "workflows");
  const problems = readdirSync(dir)
    .filter((file) => /\.ya?ml$/u.test(file))
    .toSorted()
    .flatMap((file) => checkOidcJobs(readFileSync(join(dir, file), "utf8"), file));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
