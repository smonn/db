/**
 * The checks `check-docs.ts` runs on a Markdown file's shape rather than its words: relative links
 * and anchors that resolve, and word caps that keep a budgeted doc from growing back (#511).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export type Problem = {
  file: string;
  line: number;
  message: string;
};

const MAX_BLOCK_WORDS = 120;

/** Each line of `text`, with fenced code blocks blanked so line numbers still match. */
function proseLines(text: string): string[] {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

/** The anchors GitHub gives `text`'s headings, a repeated slug numbered from `-1`. */
export function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(text)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = heading
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\s_-]/gu, "")
      .replaceAll(/\s/gu, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function hasAnchor(resolved: string, targetText: string, anchor: string | undefined): boolean {
  return (
    anchor === undefined || !resolved.endsWith(".md") || headingAnchors(targetText).has(anchor)
  );
}

function isExternal(target: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function resolveLink(
  { file, text }: { file: string; text: string },
  path: string,
  read: (path: string) => string | undefined,
): { resolved: string; targetText: string | undefined } {
  if (path === "") return { resolved: file, targetText: text };
  const resolved = posix.join(posix.dirname(file), path);
  return { resolved, targetText: read(resolved) };
}

function checkLink(
  source: { file: string; text: string; line: number },
  target: string,
  read: (path: string) => string | undefined,
): Problem[] {
  const { file, line } = source;
  if (isExternal(target)) return [];
  const [path = "", anchor] = target.split("#");
  const { resolved, targetText } = resolveLink(source, path, read);
  const message = linkFault(
    path,
    target,
    targetText,
    hasAnchor(resolved, targetText ?? "", anchor),
  );
  return message === undefined ? [] : [{ file, line, message }];
}

function linkFault(
  path: string,
  target: string,
  targetText: string | undefined,
  anchored: boolean,
): string | undefined {
  if (targetText === undefined) return `link to missing file ${path}`;
  return anchored ? undefined : `link to missing heading ${target}`;
}

/**
 * Flags each relative link whose file is missing, or whose `#anchor` names no heading in the
 * target Markdown file. `read` returns a repo path's text, `""` for a folder, or `undefined`.
 */
export function checkLinks(
  file: string,
  text: string,
  read: (path: string) => string | undefined,
): Problem[] {
  return proseLines(text).flatMap((line, index) => {
    const prose = line.replaceAll(/`[^`]*`/gu, "code");
    return [...prose.matchAll(/\]\(([^)\s]+)/gu)].flatMap(([, target = ""]) =>
      checkLink({ file, text, line: index + 1 }, target, read),
    );
  });
}

function wordCount(line: string): number {
  return line.split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

const BLOCK_START = /^\s*(?:[-*]\s|\d+\.\s|\||#)/u;
const STANDALONE = /^\s*(?:\||#)/u;

type Block = { line: number; words: number };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open = false;
  for (const [index, line] of proseLines(text).entries()) {
    if (line.trim() === "") {
      open = false;
      continue;
    }
    const last = blocks.at(-1);
    if (open && last !== undefined && !BLOCK_START.test(line)) last.words += wordCount(line);
    else blocks.push({ line: index + 1, words: wordCount(line) });
    open = !STANDALONE.test(line);
  }
  return blocks;
}

/**
 * Flags a file over `cap` words, and each paragraph, list item, or table row over
 * `MAX_BLOCK_WORDS`. Code fences don't count, so a diagram costs nothing.
 */
export function checkBudget(file: string, text: string, cap: number): Problem[] {
  const blocks = splitBlocks(text);
  const total = blocks.reduce((sum, block) => sum + block.words, 0);
  const overCap: Problem[] =
    total > cap
      ? [
          {
            file,
            line: 1,
            message: `${total} words; the cap is ${cap}. Move behavior inside one module to its TSDoc, a decision to an ADR, or cut`,
          },
        ]
      : [];
  return [
    ...overCap,
    ...blocks
      .filter(({ words }) => words > MAX_BLOCK_WORDS)
      .map(({ line, words }) => ({
        file,
        line,
        message: `block has ${words} words; the cap is ${MAX_BLOCK_WORDS}. Split it by topic, move behavior inside one module to its TSDoc, or cut`,
      })),
  ];
}

export function readRepoPath(cwd: string, path: string): string | undefined {
  const full = join(cwd, path);
  if (!existsSync(full)) return undefined;
  return statSync(full).isFile() ? readFileSync(full, "utf8") : "";
}

/** Runs `checkBudget` on each budgeted file under `cwd`, flagging one that no longer exists. */
export function checkBudgets(cwd: string, budgets: Record<string, number>): Problem[] {
  return Object.entries(budgets).flatMap(([file, cap]) => {
    const text = readRepoPath(cwd, file);
    if (text !== undefined) return checkBudget(file, text, cap);
    const message = "budgeted file is missing; update its cap in scripts/check-docs.ts";
    return [{ file, line: 1, message }];
  });
}
