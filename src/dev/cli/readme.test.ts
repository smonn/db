import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  testServerUrl,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { nameOf, repo, usePackedPackage } from "./packed-package.test-helper.ts";

const dev = useTestDatabase();
const production = useTestDatabase();
const packed = usePackedPackage();

const FENCE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gmu;
const COMMAND = /^(\w+=\S+ )?(smonndb|node) /u;
const SETUP = /^pnpm /u;

type Block = { readonly lang: string; readonly info: string; readonly body: string };
type Step = { readonly command: string; readonly expected: string };

function blocksOf(markdown: string): Block[] {
  return [...markdown.matchAll(FENCE)].map(([, lang = "", info = "", body = ""]) => ({
    lang,
    info: info.trim(),
    body,
  }));
}

function linesOf(block: Block, pattern: RegExp): string[] {
  return block.lang === "sh" ? block.body.split("\n").filter((l) => pattern.test(l)) : [];
}

/** Each `smonndb ...` or `node ...` line of a `sh` block, with the `text` block after it as its output. */
function stepsOf(blocks: readonly Block[]): Step[] {
  return blocks.flatMap((block, index) =>
    linesOf(block, COMMAND).map((command) => ({
      command,
      expected: blocks[index + 1]?.body ?? "",
    })),
  );
}

/** The `pnpm` lines of the `sh` blocks: they set the project up, and print nothing the README shows. */
function setupOf(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => linesOf(block, SETUP));
}

/** The arguments of a README `pnpm` line, with the install swapped for the local one. */
function pnpmArgs(command: string, install: string, installArgs: readonly string[]): string[] {
  return command === install ? [...installArgs] : command.split(" ").slice(1);
}

function filesOf(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => b.lang === "ts" && b.info.startsWith("file="));
}

function urlOf(name: string): string {
  const url = new URL(testServerUrl());
  url.pathname = `/${name}`;
  return url.href;
}

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-readme-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("README getting started", () => {
  it("runs as written: the files, the commands, and their output", async () => {
    const readme = (await readFile(join(repo, "README.md"), "utf8"))
      .replaceAll("postgres://localhost/app_dev", urlOf(dev.name))
      .replaceAll("postgres://localhost/app_prod", urlOf(production.name));
    const install = `pnpm add ${nameOf(packed.packedManifest)} postgres`;
    const blocks = blocksOf(readme);
    const files = filesOf(blocks);
    const steps = stepsOf(blocks);
    const setup = setupOf(blocks);
    const env = {
      ...process.env,
      DATABASE_URL: urlOf(dev.name),
      PATH: [join(project, "node_modules/.bin"), process.env["PATH"]].join(delimiter),
    };

    expect(setup).toStrictEqual(["pnpm init", install]);

    // Nothing is on the registry, so the install line runs against the packed tarball.
    for (const command of setup) {
      execFileSync("pnpm", pnpmArgs(command, install, packed.installArgs), {
        cwd: project,
        env,
        encoding: "utf8",
      });
    }
    await Promise.all(
      files.map(async ({ info, body }) => {
        const file = join(project, info.slice("file=".length));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
      }),
    );

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
    expect(steps.map((s) => s.command.includes("smonndb"))).toStrictEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(outputs).toStrictEqual(steps.map((s) => s.expected));
  }, 120_000);
});
