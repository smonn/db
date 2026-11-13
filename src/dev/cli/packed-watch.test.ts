import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { run, usePackedPackage } from "./packed-package.test-helper.ts";

const db = useTestDatabase();
const packed = usePackedPackage();
let project: string;

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-packed-watch-"));
  await mkdir(join(project, "migrations"));
  await writeFile(join(project, "package.json"), '{ "private": true, "type": "module" }\n');
  run("pnpm", packed.installArgs, project);
  await writeFile(
    join(project, "smonndb.config.ts"),
    `import { defineConfig } from "@smonn/db/dev";

export default defineConfig({
  definition: "./definition.ts",
  migrations: "./migrations",
  url: ${JSON.stringify(db.url)},
});
`,
  );
}, 240_000);

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

function writeDefinition(columns: string): Promise<void> {
  return writeFile(
    join(project, "definition.ts"),
    `import { defineDatabase, defineTable } from "@smonn/db";

export default defineDatabase({ public: { widgets: defineTable((c) => ({ ${columns} })) } });
`,
  );
}

async function untilCurrentHolds(text: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await readFile(join(project, "migrations/current.sql"), "utf8")).toContain(text);
    },
    { timeout: 20_000, interval: 50 },
  );
}

async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}

describe("the packed package's generate --watch", () => {
  // The installed package can't strip types under node_modules, so this proves the built Worker.
  it("loads the Definition in its built Worker, reruns on a change, and dies of Ctrl-C", async () => {
    await writeDefinition("id: c.integer()");
    const child = spawn(join(project, "node_modules/.bin/smonndb"), ["generate", "--watch"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      const exited = once(child, "exit");
      await untilCurrentHolds('"id" integer');

      await writeDefinition("id: c.integer(), name: c.text()");
      await untilCurrentHolds('"name" text');
      // The run writes the file before it reports, and Ctrl-C ends a run that hasn't.
      await vi.waitFor(() => {
        expect(stdout).toContain(" changed, ");
      });
      child.kill("SIGINT");

      expect(await exited).toStrictEqual([null, "SIGINT"]);
      expect(stdout).toMatch(
        /^watching definition\.ts and what it imports, and migrations\/ \(Ctrl-C to stop\)\n/u,
      );
      expect(stdout).toMatch(/^\d\d:\d\d:\d\d ok initial run \(\d+ ms\)$/mu);
      expect(stdout).toMatch(/^\d\d:\d\d:\d\d ok \S+( and \d+ more)? changed, \d+ ms$/mu);
      expect(stdout).toMatch(/^\d\d:\d\d:\d\d stopped\n$/mu);
    } catch (error) {
      throw new Error(`${String(error)}\nchild stdout:\n${stdout}\nchild stderr:\n${stderr}`, {
        cause: error,
      });
    } finally {
      await killIfRunning(child);
    }
  });

  it("prints NDJSON events with --json: a good run, a failed run, a fixed run, and a stop", async () => {
    await writeDefinition("id: c.integer()");
    const child = spawn(
      join(project, "node_modules/.bin/smonndb"),
      ["generate", "--watch", "--json"],
      { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const events = (): unknown[] =>
      stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line): unknown => JSON.parse(line));
    const untilEvents = (count: number): Promise<void> =>
      vi.waitFor(
        () => {
          expect(events().length).toBeGreaterThanOrEqual(count);
        },
        { timeout: 20_000, interval: 50 },
      );
    try {
      const exited = once(child, "exit");
      await untilEvents(2);

      await writeFile(join(project, "definition.ts"), 'throw new Error("broken definition");\n');
      await untilEvents(3);
      await writeDefinition("id: c.integer(), label: c.text()");
      await untilEvents(4);
      child.kill("SIGINT");

      expect(await exited).toStrictEqual([null, "SIGINT"]);
      expect(events()).toMatchObject([
        { event: "started", definition: "definition.ts", migrations: "migrations" },
        { event: "run", ok: true, outcome: "initial", trigger: [] },
        {
          event: "run",
          ok: false,
          trigger: expect.arrayContaining(["definition.ts"]) as unknown,
          document: {
            command: "generate",
            ok: false,
            error: {
              code: "failed",
              message: expect.stringContaining("broken definition") as unknown,
            },
          },
        },
        { event: "run", ok: true, outcome: "fixed", document: { command: "generate", ok: true } },
        { event: "stopped" },
      ]);
    } catch (error) {
      throw new Error(`${String(error)}\nchild stdout:\n${stdout}\nchild stderr:\n${stderr}`, {
        cause: error,
      });
    } finally {
      await killIfRunning(child);
    }
  });
});
