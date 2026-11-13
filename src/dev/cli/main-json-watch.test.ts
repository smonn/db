import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const cli = useCliProject();
const dev = useTestDatabase();

// The key a running `generate --watch` holds, taken here as a first watcher would.
const WATCH_LOCK_KEY = "766663292824";

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, path)).href;

async function writeProject(): Promise<string> {
  await mkdir(join(cli.dir, "migrations"), { recursive: true });
  await writeFile(
    join(cli.dir, "definition.ts"),
    `import { defineDatabase } from "${source("../../runtime/definition/index.ts")}";\n\nexport default defineDatabase({ public: {} });\n`,
  );
  const config = join(cli.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${source("../config/index.ts")}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: ${JSON.stringify(dev.url)} });\n`,
  );
  return config;
}

describe("main generate --watch --json", () => {
  it("prints one locked failure and exits 1 while another watcher holds the lock", async () => {
    const config = await writeProject();

    await dev.driver.session(async (first) => {
      await first.query(`select pg_advisory_lock(${WATCH_LOCK_KEY})`);

      expect(await main(["generate", "--watch", "--json", "--config", config])).toBe(1);
    });

    expect(cli.stdout.endsWith("\n")).toBe(true);
    expect(cli.stdout.trimEnd()).not.toContain("\n");
    expect(JSON.parse(cli.stdout)).toStrictEqual({
      command: "generate",
      ok: false,
      error: {
        code: "locked",
        message: expect.stringContaining("another generate --watch holds") as unknown,
        lock: "watch",
      },
    });
    expect(cli.stderr).toBe("");
  });
});
