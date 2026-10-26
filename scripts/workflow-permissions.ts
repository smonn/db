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

const quotedOrNot = (word: string): string => `(?:"${word}"|'${word}'|${word})`;
const scope = String.raw`${quotedOrNot("[a-z]+(?:-[a-z]+)*")}\s*:\s+${quotedOrNot("(?:read|write|none)")}`;
const flowPermissions = new RegExp(String.raw`^\{\s*(?:${scope}(?:\s*,\s*${scope})*)?\s*\}$`, "u");
const wholePermissions = new RegExp(`^${quotedOrNot("(?:read-all|write-all)")}$`, "u");
const entry = new RegExp(`^${scope}$`, "u");

// Any case, in case GitHub reads keys without it.
const isPermissions = (key: string): boolean => key.toLowerCase() === "permissions";
const permissionsForm =
  'write permissions as {}, read-all, write-all, a one-line flow map, or one "scope: level" per line';

function blockEntries(lines: WorkflowLine[], at: number, column: number): WorkflowLine[] {
  const entries: WorkflowLine[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.indent <= column) break;
    entries.push(line);
  }
  return entries;
}

const isScopeLine = (line: WorkflowLine, indent: number | undefined): boolean =>
  line.indent === indent &&
  line.key?.column === line.indent &&
  entry.test(`${line.key.name}: ${line.value}`);

function blockProblem(lines: WorkflowLine[], at: number, column: number): number | undefined {
  const entries = blockEntries(lines, at, column);
  if (entries.length === 0) return lines[at]?.number;
  const indent = entries[0]?.indent;
  return entries.find((line) => !isScopeLine(line, indent))?.number;
}

const isWholeOrFlow = (value: string): boolean =>
  flowPermissions.test(value) || wholePermissions.test(value);

function permissionsProblem(lines: WorkflowLine[], at: number, column: number): number | undefined {
  const value = lines[at]?.value ?? "";
  if (value === "") return blockProblem(lines, at, column);
  return isWholeOrFlow(value) ? undefined : lines[at]?.number;
}

export function permissionsProblems(lines: WorkflowLine[], file: string): string[] {
  const problems: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.flowKeys.some(isPermissions))
      problems.push(
        `${file} line ${line.number} sets permissions inside a flow map; ${permissionsForm}`,
      );
    if (line.key === undefined || !isPermissions(line.key.name)) continue;
    const bad = permissionsProblem(lines, index, line.key.column);
    if (bad !== undefined)
      problems.push(`${file} line ${bad} breaks a permissions block; ${permissionsForm}`);
  }
  return problems;
}
