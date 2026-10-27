/**
 * Typechecks the TypeScript examples in the README (#625). Every `ts` block names how it compiles
 * in its info string:
 *
 * - `file=<path>` writes the block to `<path>` in a temp project, so blocks import one another.
 * - `wrap=table|type|module` is a fragment. `table` (a property among a schema's tables) and `type`
 *   (a property among its enums and domains) sit in `defineDatabase({ public: { ... } })`; `module`
 *   (a bare `export default defineDatabase(...)`) follows the imports.
 *
 * The package specifiers map to `src/` through `package.json` `exports` and the `tsdown.config.ts`
 * entries, so the check needs no build. A `ts` block with neither tag fails, and a `tsc` error
 * names the README line it came from.
 *
 * Run from the repo root with `pnpm check:readme`; CI runs it in the Typecheck job.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import tsdown from "../tsdown.config.ts";

const repoRoot = join(import.meta.dirname, "..");

const IMPORTS =
  'import { defineDatabase, defineDomain, defineEnum, defineTable } from "@smonn/db";\n';
const IN_SCHEMA = `${IMPORTS}export default defineDatabase({\n  public: {\n`;
type Wrap = "table" | "type" | "module";
/** Text before and after a fragment's body. */
const WRAPPERS: Readonly<Record<Wrap, readonly [string, string]>> = {
  table: [IN_SCHEMA, "  },\n});\n"],
  type: [IN_SCHEMA, "  },\n});\n"],
  module: [IMPORTS, ""],
};

type Target = { file: string } | { wrap: Wrap };
type Block = {
  /** The README line of the opening fence. */
  line: number;
  body: string;
  target: Target;
};
type Source = { label: string; block: Block; text: string; offset: number };
type Open = { line: number; info: string[]; body: string[] };

const NEEDS_TAG = "a ts block needs exactly one of file=<path> or wrap=table|type|module";

function isWrap(word: string): word is Wrap {
  return Object.hasOwn(WRAPPERS, word);
}

function option(info: readonly string[], key: string): string | undefined {
  return info.find((word) => word.startsWith(key))?.slice(key.length);
}

function fileTarget(path: string): Target | string {
  const outside = isAbsolute(path) || path.split("/").includes("..");
  return path.endsWith(".ts") && !outside
    ? { file: path }
    : `file=${path} must be a relative .ts path inside the project`;
}

function wrapTarget(wrap: string): Target | string {
  return isWrap(wrap) ? { wrap } : `wrap=${wrap} is not one of table, type, module`;
}

function readTarget(info: readonly string[]): Target | string {
  const file = option(info, "file=");
  const wrap = option(info, "wrap=");
  if (file !== undefined && wrap === undefined) return fileTarget(file);
  if (wrap !== undefined && file === undefined) return wrapTarget(wrap);
  return NEEDS_TAG;
}

type Parsed = { blocks: Block[]; problems: string[] };

function close(open: Open, label: string, out: Parsed): void {
  if (open.info[0] !== "ts") return;
  const target = readTarget(open.info.slice(1));
  if (typeof target === "string") out.problems.push(`${label}:${open.line}: ${target}`);
  else out.blocks.push({ line: open.line, body: `${open.body.join("\n")}\n`, target });
}

/** Every `ts` fenced block in `text`, and a problem line for each block that names no valid tag. */
export function parseBlocks(text: string, label: string): Parsed {
  const out: Parsed = { blocks: [], problems: [] };
  let open: Open | undefined;
  for (const [index, row] of text.split("\n").entries()) {
    if (open === undefined) {
      const info = /^```(.*)$/u.exec(row)?.[1];
      if (info !== undefined) open = { line: index + 1, info: info.trim().split(/\s+/u), body: [] };
    } else if (row === "```") {
      close(open, label, out);
      open = undefined;
    } else open.body.push(row);
  }
  return out;
}

/** The source files to write: each block under its path, or a numbered file for a fragment. */
export function sourcesFor(groups: readonly { label: string; blocks: readonly Block[] }[]): {
  sources: Map<string, Source>;
  problems: string[];
} {
  const sources = new Map<string, Source>();
  const problems: string[] = [];
  for (const { label, blocks } of groups) {
    for (const block of blocks) {
      const wrapper = "wrap" in block.target ? WRAPPERS[block.target.wrap] : (["", ""] as const);
      const path = "file" in block.target ? block.target.file : `block-${sources.size}.ts`;
      if (sources.has(path)) {
        problems.push(`${label}:${block.line}: ${path} is already written by another block`);
        continue;
      }
      const text = `${wrapper[0]}${block.body}${wrapper[1]}`;
      sources.set(path, { label, block, text, offset: wrapper[0].split("\n").length - 1 });
    }
  }
  return { sources, problems };
}

/** Rewrites each `path(line,col)` in `tsc` output to the README line it came from. */
export function mapOutput(
  output: string,
  sources: ReadonlyMap<string, Source>,
  project: string,
): string {
  // tsc prints a path relative to its own working directory, so cut at the project's name.
  const marker = `${basename(project)}/`;
  return output.replaceAll(/^(\S+?)\((\d+),\d+\)/gmu, (match, path: string, line: string) => {
    const cut = path.lastIndexOf(marker);
    const source = sources.get(cut < 0 ? path : path.slice(cut + marker.length));
    if (source === undefined) return match;
    const inBody = Number(line) - source.offset;
    const bodyLines = source.block.body.split("\n").length - 1;
    return `${source.label}:${source.block.line + (inBody >= 1 && inBody <= bodyLines ? inBody : 0)}`;
  });
}

/** `paths` entries from each `package.json` export that points at a built `dist/<entry>.mjs`. */
export function specifierPaths(
  name: string,
  exports: Readonly<Record<string, unknown>>,
  entry: Readonly<Record<string, unknown>>,
  root: string,
): Record<string, string[]> {
  const pairs = Object.entries(exports).flatMap(([key, target]): [string, string[]][] => {
    const built =
      typeof target === "string" ? /^\.\/dist\/(.+)\.mjs$/u.exec(target)?.[1] : undefined;
    const source = built === undefined ? undefined : entry[built];
    return typeof source === "string" ? [[`${name}${key.slice(1)}`, [join(root, source)]]] : [];
  });
  return Object.fromEntries(pairs);
}

function entries(): Record<string, unknown> {
  const { entry } = tsdown;
  return typeof entry === "object" && !Array.isArray(entry) ? entry : {};
}

function writeProject(root: string, project: string, sources: ReadonlyMap<string, Source>): void {
  symlinkSync(join(root, "node_modules"), join(project, "node_modules"), "dir");
  const config = {
    extends: join(root, "tsconfig.json"),
    // Examples run as a user would write them, so the repo's own strictness extras stay off.
    compilerOptions: {
      paths: specifierPaths(pkg.name, pkg.exports, entries(), root),
      noUnusedLocals: false,
      isolatedDeclarations: false,
      noPropertyAccessFromIndexSignature: false,
    },
    include: ["./**/*.ts"],
  };
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify(config));
  writeFileSync(join(project, "package.json"), '{"type":"module"}');
  for (const [path, source] of sources) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), source.text);
  }
}

/** Typechecks `sources` in a temp project and returns tsc's output, with README lines. */
function typecheck(root: string, sources: ReadonlyMap<string, Source>): string | undefined {
  const project = mkdtempSync(join(tmpdir(), "check-readme-examples-"));
  try {
    writeProject(root, project, sources);
    const tsc = spawnSync(
      join(root, "node_modules/.bin/tsc"),
      ["-p", project, "--pretty", "false"],
      { encoding: "utf8" },
    );
    const output = `${tsc.stdout}${tsc.stderr}`.trim();
    return tsc.status === 0 ? undefined : mapOutput(output, sources, project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

export function main(files: readonly string[] = ["README.md"], root: string = repoRoot): void {
  const parsed = files.map((label) => ({
    label,
    ...parseBlocks(readFileSync(resolve(root, label), "utf8"), label),
  }));
  const { sources, problems: clashes } = sourcesFor(parsed);
  const problems = [...parsed.flatMap((entry) => entry.problems), ...clashes];
  const failure = sources.size === 0 ? undefined : typecheck(root, sources);
  const report = [...problems, ...(failure === undefined ? [] : [failure])];
  if (report.length === 0) return;
  console.error(report.join("\n"));
  process.exitCode = 1;
}

if (import.meta.main) main();
