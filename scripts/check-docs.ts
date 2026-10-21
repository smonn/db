/**
 * Checks the repo's Markdown against the glossary and ADR template: no `_Avoid_` term from
 * GLOSSARY.md outside its own entry, no `_Avoid_` term that is also a headword, no ADR body over
 * three sentences, no case variant of a multi-word headword, no two ADRs sharing a number, and
 * no em-dashes. Also rejects literal em-dashes in `scripts/` and `src/`
 * TypeScript. Prints `file:line: problem` and exits 1 on any problem.
 *
 * Run from the repo root with `pnpm check:docs`; CI runs it in the Docs job.
 */
import { globSync, readFileSync } from "node:fs";
import { markdownFiles } from "./markdown-files.ts";

export type GlossaryEntry = {
  headword: string;
  avoid: string[];
  startLine: number;
  endLine: number;
};

export type Problem = {
  file: string;
  line: number;
  message: string;
};

const MAX_ADR_SENTENCES = 3;
const EM_DASH = "\u2014";

export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  let current: GlossaryEntry | undefined;
  text.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const headword = /^\*\*(.+)\*\*:\s*$/.exec(line)?.[1];
    if (headword !== undefined) {
      current = { headword, avoid: [], startLine: lineNumber, endLine: lineNumber };
      entries.push(current);
      return;
    }
    if (current === undefined) return;
    if (line.trim() === "") {
      current = undefined;
      return;
    }
    current.endLine = lineNumber;
    const avoid = /^_Avoid_:\s*(.+)$/.exec(line)?.[1];
    if (avoid !== undefined) current.avoid = avoid.split(",").map((term) => term.trim());
  });
  return entries;
}

export function checkGlossary(entries: GlossaryEntry[]): Problem[] {
  const headwords = new Set(entries.map((entry) => entry.headword.toLowerCase()));
  return entries.flatMap((entry) =>
    entry.avoid
      .filter((term) => headwords.has(term.toLowerCase()))
      .map((term) => ({
        file: "GLOSSARY.md",
        line: entry.endLine,
        message: `"${term}" is avoided but is also a glossary term`,
      })),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkAvoidTerms(file: string, text: string, entries: GlossaryEntry[]): Problem[] {
  const rules = entries.flatMap((entry) =>
    entry.avoid.map((term) => ({
      entry,
      term,
      pattern: new RegExp(`\\b${escapeRegExp(term)}(?:s|es)?\\b`, "i"),
    })),
  );
  return text.split("\n").flatMap((line, index) => {
    const lineNumber = index + 1;
    return rules
      .filter(({ entry, pattern }) => {
        const inOwnEntry =
          file === "GLOSSARY.md" && lineNumber >= entry.startLine && lineNumber <= entry.endLine;
        return !inOwnEntry && pattern.test(line);
      })
      .map(({ entry, term }) => ({
        file,
        line: lineNumber,
        message: `avoid "${term}" (use "${entry.headword}")`,
      }));
  });
}

// Lowercase single-word headwords like "database" are ordinary English, so they're skipped.
export function checkHeadwordCase(file: string, text: string, entries: GlossaryEntry[]): Problem[] {
  const headwords = entries.map((entry) => entry.headword).filter((word) => word.includes(" "));
  return text.split("\n").flatMap((line, index) => {
    const prose = line.replace(/`[^`]*`/g, "code");
    return headwords.flatMap((headword) =>
      [...prose.matchAll(new RegExp(`\\b(${escapeRegExp(headword)})(?:s|es)?\\b`, "gi"))]
        .map((match) => match[1] ?? "")
        .filter((variant) => variant !== headword)
        .map((variant) => ({
          file,
          line: index + 1,
          message: `write "${headword}", not "${variant}"`,
        })),
    );
  });
}

export function checkEmDashes(file: string, text: string): Problem[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      line.includes(EM_DASH) ? [{ file, line: index + 1, message: "em-dash" }] : [],
    );
}

export function checkAdrBody(file: string, text: string): Problem[] {
  const lines = text.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  if (titleIndex === -1) return [{ file, line: 1, message: "ADR has no title" }];
  const sectionIndex = lines.findIndex(
    (line, index) => index > titleIndex && line.startsWith("## "),
  );
  const body = lines
    .slice(titleIndex + 1, sectionIndex === -1 ? undefined : sectionIndex)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`]*`/g, "code");
  // A sentence ends at terminal punctuation followed by whitespace, which skips dots in "v0.1".
  const sentences = body.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== "");
  if (sentences.length <= MAX_ADR_SENTENCES) return [];
  return [
    {
      file,
      line: titleIndex + 1,
      message: `ADR body has ${sentences.length} sentences; the template allows ${MAX_ADR_SENTENCES}`,
    },
  ];
}

export function checkAdrNumbers(files: string[]): Problem[] {
  const firstByNumber = new Map<string, string>();
  return files.flatMap((file) => {
    const number = /^docs\/adr\/(\d{4})-/.exec(file)?.[1];
    if (number === undefined) return [];
    const first = firstByNumber.get(number);
    if (first === undefined) {
      firstByNumber.set(number, file);
      return [];
    }
    return [{ file, line: 1, message: `ADR number ${number} is also used by ${first}` }];
  });
}

function main(): void {
  const files = markdownFiles();
  const glossary = parseGlossary(readFileSync("GLOSSARY.md", "utf8"));
  const problems = [...checkGlossary(glossary), ...checkAdrNumbers(files)];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    problems.push(...checkEmDashes(file, text));
    if (file === "README.md" || file === "GLOSSARY.md" || file.startsWith("docs/")) {
      problems.push(...checkAvoidTerms(file, text, glossary));
      problems.push(...checkHeadwordCase(file, text, glossary));
    }
    if (/^docs\/adr\/\d{4}-[^/]+\.md$/.test(file)) {
      problems.push(...checkAdrBody(file, text));
    }
  }
  // Editor tools can turn a typed `\u2014` escape into the literal character.
  for (const file of globSync("{scripts,src}/**/*.ts").sort()) {
    problems.push(...checkEmDashes(file, readFileSync(file, "utf8")));
  }
  for (const { file, line, message } of problems) console.error(`${file}:${line}: ${message}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
