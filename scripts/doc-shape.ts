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
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? undefined : target.slice(hash + 1);
  const { resolved, targetText } = resolveLink(source, path, read);
  if (targetText === undefined) return [{ file, line, message: `link to missing file ${path}` }];
  if (hasAnchor(resolved, targetText, anchor)) return [];
  return [{ file, line, message: `link to missing heading ${target}` }];
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
  return proseLines(text).flatMap((line, index) =>
    // A code span matches first, so a link inside one isn't read.
    [...line.matchAll(/`[^`]*`|\]\(([^)\s]+)/gu)].flatMap(([, target]) =>
      target === undefined ? [] : checkLink({ file, text, line: index + 1 }, target, read),
    ),
  );
}

function wordCount(line: string): number {
  return [...line.matchAll(/\S+/gu)].filter(([token]) => /[\p{L}\p{N}]/u.test(token)).length;
}

const BLOCK_START = /^\s*(?:[-*]\s|\d+\.\s|\||#)/u;
const STANDALONE = /^\s*(?:\||#)/u;

type Block = { line: number; words: number };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  // The block a following line may continue, if any.
  let open: Block | undefined;
  for (const [index, line] of proseLines(text).entries()) {
    if (line.trim() === "") {
      open = undefined;
      continue;
    }
    if (open !== undefined && !BLOCK_START.test(line)) {
      open.words += wordCount(line);
    } else {
      open = { line: index + 1, words: wordCount(line) };
      blocks.push(open);
    }
    if (STANDALONE.test(line)) open = undefined;
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
  // Stryker disable next-line StringLiteral: 1 survivor: a folder's text is only read for anchors in a `.md` file or counted against a budget, where any short stand-in string stays under the cap.
  if (!statSync(full).isFile()) return "";
  return readFileSync(full, "utf8");
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
