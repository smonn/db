/**
 * Holds every `permissions` key in a workflow to a form that reads as one grant per line: `{}`,
 * `read-all`, `write-all`, a one-line flow map, or one `scope: level` per line. Anything else, such
 * as a value on the next line or a permissions key inside a flow map, is a problem. Reads the lines
 * scripts/workflow-yaml.ts produces, which has already refused anchors, tags, and escapes.
 */

export type WorkflowLine = {
  number: number;
  indent: number;
  key?: { name: string; column: number };
  value: string;
  flowKeys: string[];
};

// Stryker disable next-line StringLiteral: nothing in these ASCII patterns tells the flag apart; it only satisfies require-unicode-regexp.
const compile = (pattern: string): RegExp => new RegExp(pattern, "u");
const quotedOrNot = (word: string): string => `(?:"${word}"|'${word}'|${word})`;
const scope = String.raw`${quotedOrNot("[a-z]+(?:-[a-z]+)*")}\s*:\s+${quotedOrNot("(?:read|write|none)")}`;
const flowPermissions = compile(String.raw`^\{\s*(?:${scope}(?:\s*,\s*${scope})*)?\s*\}$`);
const wholePermissions = compile(`^${quotedOrNot("(?:read-all|write-all)")}$`);
const entry = compile(`^${scope}$`);

// Any case, in case GitHub reads keys without it.
const isPermissions = (key: string): boolean => key.toLowerCase() === "permissions";
const permissionsForm =
  'write permissions as {}, read-all, write-all, a one-line flow map, or one "scope: level" per line';

function blockEntries(following: WorkflowLine[], column: number): WorkflowLine[] {
  const entries: WorkflowLine[] = [];
  for (const line of following) {
    if (line.indent <= column) break;
    entries.push(line);
  }
  return entries;
}

const isScopeLine = (line: WorkflowLine, indent: number): boolean =>
  line.indent === indent &&
  line.key?.column === line.indent &&
  entry.test(`${line.key.name}: ${line.value}`);

function blockProblem(
  owner: WorkflowLine,
  following: WorkflowLine[],
  column: number,
): number | undefined {
  const entries = blockEntries(following, column);
  const [first] = entries;
  if (first === undefined) return owner.number;
  return entries.find((line) => !isScopeLine(line, first.indent))?.number;
}

const isWholeOrFlow = (value: string): boolean =>
  flowPermissions.test(value) || wholePermissions.test(value);

function permissionsProblem(
  owner: WorkflowLine,
  following: WorkflowLine[],
  column: number,
): number | undefined {
  if (owner.value === "") return blockProblem(owner, following, column);
  return isWholeOrFlow(owner.value) ? undefined : owner.number;
}

export function permissionsProblems(lines: WorkflowLine[], file: string): string[] {
  const problems: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.flowKeys.some(isPermissions))
      problems.push(
        `${file} line ${line.number} sets permissions inside a flow map; ${permissionsForm}`,
      );
    if (line.key === undefined || !isPermissions(line.key.name)) continue;
    const bad = permissionsProblem(line, lines.slice(index + 1), line.key.column);
    if (bad !== undefined)
      problems.push(`${file} line ${bad} breaks a permissions block; ${permissionsForm}`);
  }
  return problems;
}
