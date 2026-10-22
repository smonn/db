import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.ts";

const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

let project: string;
let stderr: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-cli-"));
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

async function writeConfig(body: string): Promise<string> {
  const file = join(project, "smonndb.config.ts");
  await writeFile(file, `import { defineConfig } from "${defineConfigUrl}";\n\n${body}`);
  return file;
}

describe("main", () => {
  it.each([
    [[], "name a command"],
    [["deploy"], "unknown command deploy"],
    [["generate", "now"], "generate takes no arguments: now"],
    [["migrate", "a", "b"], "migrate takes no arguments: a b"],
    [["commit"], "commit takes one argument, the slug"],
    [["commit", "a", "b"], "commit takes one argument, the slug"],
    [["migrate", "--url", "postgres://"], "Unknown option '--url'"],
  ])("exits 2 with the usage for %j", async (argv, message) => {
    expect(await main(argv)).toBe(2);
    expect(stderr).toContain(message);
    expect(stderr).toContain("usage: smonndb <command> [--config <path>]");
  });

  it("exits 1 when the config file is missing, naming it", async () => {
    expect(await main(["migrate", "--config", join(project, "missing.config.ts")])).toBe(1);
    expect(stderr).toContain("missing.config.ts");
  });

  it("exits 1 when the config file has no default export", async () => {
    const file = await writeConfig("export const config = {};\n");

    expect(await main(["migrate", "--config", file])).toBe(1);
    expect(stderr).toBe(
      `${relative(process.cwd(), file)} must export defineConfig({ ... }) as its default export\n`,
    );
  });

  it("exits 1 when the config's url is unset", async () => {
    const file = await writeConfig(
      `export default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: undefined });\n`,
    );

    expect(await main(["migrate", "--config", file])).toBe(1);
    expect(stderr).toContain("url is undefined; set the environment variable it reads");
  });

  it("exits 1 when the Definition file has no default export, before connecting", async () => {
    await writeFile(join(project, "definition.ts"), "export const users = {};\n");
    const file = await writeConfig(
      `export default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: "postgres://localhost:1/none" });\n`,
    );

    expect(await main(["generate", "--config", file])).toBe(1);
    expect(stderr).toBe(
      `${relative(process.cwd(), join(project, "definition.ts"))} must export defineDatabase({ ... }) as its default export\n`,
    );
  });
});
