import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";

const admin = useTestDatabase();

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, path)).href;

const DEFINITION = `import { defineDatabase } from "${source("../../runtime/definition/index.ts")}";

export default defineDatabase({ public: {} });
`;

// Stalls the replay of the Committed migrations into the Shadow database.
const STALL = "select pg_sleep(60);\n";

async function ownedDatabases(role: string): Promise<string[]> {
  const { rows } = await admin.driver.query(
    "select datname from pg_database where datdba = $1::regrole order by datname",
    [role],
  );
  return rows.map(({ datname }) => String(datname));
}

async function stallingProject(url: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "smonn-db-interrupt-"));
  await mkdir(join(project, "db", "migrations"), { recursive: true });
  await writeFile(join(project, "db", "definition.ts"), DEFINITION);
  await writeFile(
    join(project, "smonndb.config.ts"),
    `import { defineConfig } from "${source("../config/index.ts")}";

export default defineConfig({
  definition: "./db/definition.ts",
  migrations: "./db/migrations",
  url: ${JSON.stringify(url)},
});
`,
  );
  const stall = await writeMigration("000001-stall.sql", undefined, STALL);
  await writeFile(join(project, "db", "migrations", stall.filename), stall.content);
  return project;
}

describe("smonndb generate, interrupted", () => {
  // Its own role, so the databases it owns are the Dev database and the ones generate creates.
  it.each(["SIGINT", "SIGTERM"] as const)(
    "drops its Shadow and Definition databases on %s, then dies of the signal",
    async (signal) => {
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const role = `smonn_db_interrupt_${suffix}`;
      const dev = `smonn_db_interrupt_dev_${suffix}`;
      await admin.driver.execute(`create role ${role} login createdb password '${suffix}'`);
      await admin.driver.execute(`create database ${dev} owner ${role}`);
      const url = new URL(String(process.env["DATABASE_URL"]));
      url.username = role;
      url.password = suffix;
      url.pathname = `/${dev}`;
      const project = await stallingProject(url.href);
      try {
        const child = spawn(process.execPath, [join(import.meta.dirname, "bin.ts"), "generate"], {
          cwd: project,
          stdio: "ignore",
        });
        const exited = once(child, "exit");
        await vi.waitFor(
          async () => {
            const { rows } = await admin.driver.query(
              "select from pg_stat_activity where usename = $1 and wait_event = 'PgSleep'",
              [role],
            );
            expect(rows).toHaveLength(1);
          },
          { timeout: 20_000, interval: 50 },
        );
        expect(await ownedDatabases(role)).toHaveLength(3);

        child.kill(signal);

        expect(await exited).toStrictEqual([null, signal]);
        expect(await ownedDatabases(role)).toStrictEqual([dev]);
      } finally {
        await Promise.all(
          (await ownedDatabases(role)).map((name) =>
            admin.driver.execute(`drop database ${name} with (force)`),
          ),
        );
        await admin.driver.execute(`drop role ${role}`);
        await rm(project, { recursive: true, force: true });
      }
    },
  );
});
