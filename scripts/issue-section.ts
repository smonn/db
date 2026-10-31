/**
 * Appends lines to the end of one section's list in a GitHub issue body, such as the map's
 * Decisions so far or a ticket's Done when, and leaves the rest of the body byte-identical. It
 * reads the body right before it writes, and exits 1 without writing when the heading is missing
 * or appears more than once. See "Wayfinding operations" in docs/agents/issue-tracker.md.
 *
 * Run it with `node scripts/issue-section.ts <issue number> --section "<## heading>" --append
 * <line-file>` from a clone with `gh` signed in. Writing is a read-modify-write, so an edit made
 * by someone else between the read and the write is still lost.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { field, nullable, parseJson, record, string } from "./github-json.ts";

const USAGE =
  'Usage: node scripts/issue-section.ts <issue number> --section "<## heading>" --append <line-file>';

const HEADING = /^(#{1,6})(?: |$)/u;
const FENCE = /^ {0,3}([`~])\1{2}/u;
// Stryker disable next-line Regex: 1 survivors: an indented item matches the same lines through its parent item, so `\s*` is not observable.
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u;

type Line = { text: string; code: boolean };
type Section = { start: number; end: number };

/** Flags each line that is a code fence or inside one. */
function classify(lines: string[]): Line[] {
  let fence: string | undefined;
  return lines.map((text) => {
    const marker = FENCE.exec(text)?.[1];
    if (marker === undefined) return { text, code: fence !== undefined };
    if (fence === undefined) fence = marker;
    else if (marker === fence) fence = undefined;
    // Stryker disable next-line BooleanLiteral: 1 survivors: a fence line is neither a heading nor a list item, so its flag is not observable.
    return { text, code: true };
  });
}

/** Index ranges (end exclusive) of every section whose heading line equals `heading`. */
function findSections(lines: Line[], heading: string): Section[] {
  const level = heading.indexOf(" ");
  const headings = lines.flatMap(({ text, code }, index) => {
    const hashes = code ? undefined : HEADING.exec(text)?.[1];
    return hashes === undefined ? [] : [{ index, level: hashes.length, text }];
  });
  return headings.flatMap((found, position) => {
    if (found.text.trimEnd() !== heading) return [];
    const next = headings.slice(position + 1).find((other) => other.level <= level);
    return [{ start: found.index, end: next?.index ?? lines.length }];
  });
}

/** Last line of the last list item in the section, with its continuation lines, or undefined. */
function listEnd(lines: Line[], { start, end }: Section): number | undefined {
  const inner = lines.slice(start + 1, end);
  const last = inner.findLastIndex(({ text, code }) => !code && LIST_ITEM.test(text));
  if (last === -1) return undefined;
  let tail = last;
  let blank = false;
  for (const [offset, { text }] of inner.slice(last + 1).entries()) {
    if (text.trim() === "") blank = true;
    else if (blank && !/^\s/u.test(text)) break;
    else {
      tail = last + 1 + offset;
      blank = false;
    }
  }
  return start + 1 + tail;
}

/** Index of the last non-blank line of the section, which is at least its heading. */
function lastContent(lines: Line[], { start, end }: Section): number {
  return start + lines.slice(start, end).findLastIndex(({ text }) => text.trim() !== "");
}

/**
 * The body with `added` placed after the section's last list item. A section without a list gets
 * the lines after its last content, set off by a blank line. Throws when the heading is missing
 * or repeated.
 */
export function appendToSection(body: string, heading: string, added: string[]): string {
  const lines = body.split("\n");
  const parsed = classify(lines);
  const sections = findSections(parsed, heading);
  const [section] = sections;
  if (section === undefined) throw new Error(`no "${heading}" heading in the issue body`);
  if (sections.length > 1) {
    throw new Error(`"${heading}" appears ${sections.length} times in the issue body`);
  }
  const after = listEnd(parsed, section);
  const at = after ?? lastContent(parsed, section);
  const eol = body.includes("\r\n") ? "\r" : "";
  const inserted = added.map((line) => line + eol);
  if (after === undefined) inserted.unshift(eol);
  lines.splice(at + 1, 0, ...inserted);
  return lines.join("\n");
}

/** The lines of an append file, without the file's final line break. */
export function parseLines(text: string): string[] {
  return text.replace(/\r?\n$/u, "").split(/\r?\n/u);
}

function gh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result.stdout;
}

function readBody(path: string): string {
  const issue = record(parseJson(gh(["api", path]), `gh api ${path}`), "$");
  const body = field(issue, "body", nullable(string), "$");
  if (body === null) throw new Error(`${path} has no body`);
  return body;
}

type Request = { issue: number; heading: string; file: string };

function parseRequest(args: string[]): Request | undefined {
  const { values, positionals } = parseArgs({
    args,
    options: { section: { type: "string" }, append: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  const issue = Number(positionals[0]);
  const { section: heading, append: file } = values;
  // Strict parsing throws on an unknown flag; without it one shows up as a third key.
  const unknownFlag = Object.keys(values).length !== 2;
  if (positionals.length !== 1 || !isIssueNumber(issue) || unknownFlag) return undefined;
  if (!isHeadingLine(heading)) return undefined;
  return typeof file === "string" ? { issue, heading, file } : undefined;
}

function isIssueNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isHeadingLine(value: unknown): value is string {
  // Stryker disable next-line ConditionalExpression: 1 survivors: a flag with no value leaves `true`, which the heading pattern rejects too.
  return typeof value === "string" && /^#{1,6} \S/u.test(value);
}

function run({ issue, heading, file }: Request): void {
  const added = parseLines(readFileSync(file, "utf8"));
  if (added.every((line) => line.trim() === "")) throw new Error(`${file} has no lines to append`);
  const path = `repos/{owner}/{repo}/issues/${issue}`;
  const body = appendToSection(readBody(path), heading, added);
  gh(["api", "--method", "PATCH", path, "--input", "-"], JSON.stringify({ body }));
}

export function main(args: string[] = process.argv.slice(2)): void {
  const request = parseRequest(args);
  if (request === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    run(request);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) main();
