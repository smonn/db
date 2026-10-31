/**
 * Starts this worktree's own test Postgres and writes its URL to `.env.test`, which
 * vitest.config.ts reads when `DATABASE_URL` is unset. The compose project is named after the
 * worktree's directory, and Docker picks the host port, so parallel worktrees never collide.
 * Rerunning it reuses a running server. Starting also removes the test servers of worktrees that
 * no longer exist.
 *
 * Run it with `node scripts/test-db.ts`, and `node scripts/test-db.ts stop` to remove the server.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { orphanedProjects, worktreesFolder } from "./compose-orphans.ts";

export function projectName(root: string): string {
  return `smonndb-${basename(root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/gu, "-")}`;
}

export function parsePort(address: string): number | undefined {
  const lines = address.split("\n");
  // Stryker disable next-line StringLiteral: 1 survivor: split always returns a first line, so the fallback only satisfies noUncheckedIndexedAccess.
  const match = /:(\d+)\s*$/u.exec(lines[0] ?? "");
  return match === null ? undefined : Number(match[1]);
}

function compose(root: string, name: string, args: string[], env = process.env) {
  const result = spawnSync("docker", ["compose", "-p", name, ...args], {
    encoding: "utf8",
    cwd: root,
    env,
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

function runningPort(root: string, name: string): number | undefined {
  const result = compose(root, name, ["port", "postgres", "5432"]);
  return result.ok ? parsePort(result.out) : undefined;
}

function removeOrphans(root: string): void {
  // A failed listing has empty stdout, which names nothing; `up` then reports the real error.
  const { stdout } = spawnSync("docker", ["compose", "ls", "--all", "--format", "json"], {
    encoding: "utf8",
    cwd: root,
  });
  for (const name of orphanedProjects(stdout, worktreesFolder(root), existsSync)) {
    const down = compose(root, name, ["down", "--volumes"]);
    if (down.ok) console.log(`Removed ${name}, whose worktree is gone`);
    else console.warn(`Could not remove ${name}:\n${down.out}`);
  }
}

function start(root: string, name: string): void {
  removeOrphans(root);
  let port = runningPort(root, name);
  if (port === undefined) {
    // Port 0 lets Docker choose a free host port.
    const up = compose(root, name, ["up", "-d", "--wait"], { ...process.env, POSTGRES_PORT: "0" });
    if (!up.ok) throw new Error(`docker compose -p ${name} up -d --wait failed:\n${up.out}`);
    port = runningPort(root, name);
    if (port === undefined) throw new Error(`${name} started but publishes no port for 5432`);
  }
  writeFileSync(
    join(root, ".env.test"),
    `DATABASE_URL=postgres://postgres:postgres@localhost:${port}/postgres\n`,
  );
  // Compose names a service's container <project>-<service>-<replica>.
  console.log(`Container ${name}-postgres-1 is on port ${port}; wrote .env.test`);
}

function stop(root: string, name: string): void {
  const down = compose(root, name, ["down", "--volumes"]);
  if (!down.ok) throw new Error(`docker compose -p ${name} down failed:\n${down.out}`);
  rmSync(join(root, ".env.test"), { force: true });
  console.log(`Stopped ${name} and removed .env.test`);
}

const actions = new Map([
  ["start", start],
  ["stop", stop],
]);

export function main(
  args: string[],
  root: string = fileURLToPath(new URL("..", import.meta.url)),
): void {
  const name = projectName(root);
  const [command = "start", ...rest] = args;
  const action = rest.length === 0 ? actions.get(command) : undefined;
  if (action === undefined) {
    throw new Error(
      `Unknown arguments "${args.join(" ")}". Usage: node scripts/test-db.ts [start|stop]`,
    );
  }
  action(root, name);
}

if (import.meta.main) main(process.argv.slice(2));
