import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";

const dev = useTestDatabase();
const production = useTestDatabase();

const repo = join(import.meta.dirname, "../../..");
const FENCE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gmu;
const COMMAND = /^(\w+=\S+ )?node /u;

type Block = { readonly lang: string; readonly info: string; readonly body: string };
type Step = { readonly command: string; readonly expected: string };

function blocksOf(markdown: string): Block[] {
  return [...markdown.matchAll(FENCE)].map(([, lang = "", info = "", body = ""]) => ({
    lang,
    info: info.trim(),
    body,
  }));
}

/** Each `node ...` line of a `sh` block, with the `text` block that follows it as its output. */
function stepsOf(blocks: readonly Block[]): Step[] {
  return blocks.flatMap((block, index) => {
    const commands =
      block.lang === "sh" ? block.body.split("\n").filter((l) => COMMAND.test(l)) : [];
    return commands.map((command) => ({ command, expected: blocks[index + 1]?.body ?? "" }));
  });
}

function filesOf(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => b.lang === "ts" && b.info.startsWith("file="));
}

function urlOf(name: string): string {
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  url.pathname = `/${name}`;
  return url.href;
}

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-readme-"));
  await symlink(join(repo, "node_modules"), join(project, "node_modules"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("README getting started", () => {
  it("runs as written: the files, the commands, and their output", async () => {
    const readme = (await readFile(join(repo, "README.md"), "utf8"))
      .replaceAll("/path/to/smonn-db", repo)
      .replaceAll("postgres://localhost/app_dev", urlOf(dev.name))
      .replaceAll("postgres://localhost/app_prod", urlOf(production.name));
    const blocks = blocksOf(readme);
    const files = filesOf(blocks);
    await Promise.all(
      files.map(async ({ info, body }) => {
        const file = join(project, info.slice("file=".length));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
      }),
    );
    const steps = stepsOf(blocks);
    const env = { ...process.env, DATABASE_URL: urlOf(dev.name) };

    const outputs = steps.map(({ command }) =>
      execFileSync("sh", ["-c", command], { cwd: project, env, encoding: "utf8" }),
    );

    expect(files.map((f) => f.info)).toStrictEqual([
      "file=db/definition.ts",
      "file=smonndb.config.ts",
      "file=query.ts",
    ]);
    expect(steps.map((s) => s.command.split(" ").at(-1))).toStrictEqual([
      "generate",
      "create-users",
      "migrate",
      "query.ts",
    ]);
    expect(outputs).toStrictEqual(steps.map((s) => s.expected));
  }, 60_000);
});
