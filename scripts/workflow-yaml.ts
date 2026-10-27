/**
 * Refuses the YAML a line reader can't follow, so scripts/check-oidc-jobs.ts can find every
 * `permissions` grant without a YAML parser. It reads each line, skipping block scalar content, and
 * refuses: a character outside printable ASCII (YAML 1.1 reads U+0085 as a line break, and JavaScript
 * reads U+00A0 as a space where bash doesn't), an explicit key, an anchor, alias, or tag, an escape
 * in a double-quoted scalar, a quoted scalar or flow collection that spans lines, and a document
 * marker or directive. It then holds every `permissions` key to the forms in
 * scripts/workflow-permissions.ts.
 */
import { permissionsProblems, type WorkflowLine } from "./workflow-permissions.ts";

import {
  endsLine,
  flowEnd,
  indentOf,
  quotedEnd,
  refuseNodeStart,
  refuseTrailing,
  skipSpaces,
  Unreadable,
} from "./workflow-yaml-flow.ts";

type Key = NonNullable<WorkflowLine["key"]>;

function refuseBlockHeader(text: string, at: number): void {
  if (!/^[|>][-+0-9]*\s*(?:#.*)?$/u.test(text.slice(at))) {
    throw new Unreadable("a block scalar header");
  }
}

function refuseValueTrailing(text: string, at: number, flowKeys: string[]): void {
  const char = text[at];
  if (char === "{" || char === "[") {
    refuseTrailing(text, flowEnd(text, at, flowKeys), "a flow collection");
  } else if (char === '"' || char === "'") {
    refuseTrailing(text, quotedEnd(text, at), "a quoted scalar");
  }
}

// Returns whether the value starts a block scalar.
function readValue(text: string, at: number, flowKeys: string[]): boolean {
  refuseNodeStart(text, at);
  if (text[at] === "|" || text[at] === ">") {
    refuseBlockHeader(text, at);
    return true;
  }
  refuseValueTrailing(text, at, flowKeys);
  return false;
}

const plainKey = /^([^#]*?)\s*:(?:\s|$)/u;

function readQuotedKey(text: string, at: number): { key: Key; next: number } | undefined {
  const end = quotedEnd(text, at);
  const colon = skipSpaces(text, end);
  if (text[colon] !== ":") return undefined;
  return { key: { name: text.slice(at + 1, end - 1), column: at }, next: colon + 1 };
}

function readPlainKey(text: string, at: number): { key: Key; next: number } | undefined {
  const match = plainKey.exec(text.slice(at));
  if (match?.[1] === undefined) return undefined;
  return { key: { name: match[1], column: at }, next: at + match[0].length };
}

function readKey(text: string, at: number): { key: Key; next: number } | undefined {
  const char = text[at];
  if (char === "{" || char === "[") return undefined;
  if (char === '"' || char === "'") return readQuotedKey(text, at);
  return readPlainKey(text, at);
}

function skipDashes(text: string): { at: number; dash: number } {
  let at = indentOf(text);
  let dash = -1;
  while (text[at] === "-" && (text[at + 1] === " " || at + 1 === text.length)) {
    dash = at;
    at = skipSpaces(text, at + 1);
  }
  return { at, dash };
}

type Read = { line: WorkflowLine; scalarAbove?: number };

const blockOwnerColumn = (keyColumn: number | undefined, dash: number, indent: number): number =>
  keyColumn ?? (dash === -1 ? indent : dash);

function refuseDocumentMarker(text: string): void {
  if (/^(?:---|\.\.\.)(?:\s|$)|^%/u.test(text)) {
    throw new Unreadable("a document marker or directive");
  }
}

function readLine(number: number, text: string): Read {
  refuseDocumentMarker(text);
  const start = skipDashes(text);
  let at = start.at;
  const dash = start.dash;
  const line: WorkflowLine = { number, indent: indentOf(text), value: "", flowKeys: [] };
  if (endsLine(text, at)) return { line };
  refuseNodeStart(text, at);
  const read = readKey(text, at);
  if (read !== undefined) {
    line.key = read.key;
    at = skipSpaces(text, read.next);
    if (endsLine(text, at)) return { line };
  }
  line.value = text.slice(at).replace(/\s#.*/u, "").trim();
  if (!readValue(text, at, line.flowKeys)) return { line };
  return { line, scalarAbove: blockOwnerColumn(read?.key.column, dash, line.indent) };
}

function outsideAsciiProblem(text: string, number: number, file: string): string | undefined {
  const outside = /[^ -~]/u.exec(text)?.[0];
  if (outside === undefined) return undefined;
  const code = Number(outside.codePointAt(0)).toString(16).toUpperCase().padStart(4, "0");
  return `${file} line ${number} holds U+${code}, outside printable ASCII; this check reads printable ASCII only`;
}

type Step = { scalarAbove?: number | undefined; line?: WorkflowLine; problem?: string };

function readOrProblem(number: number, text: string, file: string): Step {
  try {
    const read = readLine(number, text);
    return { line: read.line, scalarAbove: read.scalarAbove };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { problem: `${file} line ${number} uses ${error.message}, which this check can't read` };
  }
}

const continuesScalar = (text: string, scalarAbove: number | undefined): boolean =>
  indentOf(text) > (scalarAbove ?? Infinity);

function stepLine(
  text: string,
  number: number,
  file: string,
  scalarAbove: number | undefined,
): Step {
  const outside = outsideAsciiProblem(text, number, file);
  if (outside !== undefined) return { problem: outside, scalarAbove };
  if (text.trim() === "" || continuesScalar(text, scalarAbove)) return { scalarAbove };
  if (text.trimStart().startsWith("#")) return {};
  return readOrProblem(number, text, file);
}

export function readWorkflow(
  workflow: string,
  file: string,
): { lines: WorkflowLine[]; problems: string[] } {
  const problems: string[] = [];
  const lines: WorkflowLine[] = [];
  let scalarAbove: number | undefined;
  for (const [index, text] of workflow.split("\n").entries()) {
    const step = stepLine(text, index + 1, file, scalarAbove);
    scalarAbove = step.scalarAbove;
    if (step.problem !== undefined) problems.push(step.problem);
    if (step.line !== undefined) lines.push(step.line);
  }
  return { lines, problems };
}

export function workflowYamlProblems(workflow: string, file: string): string[] {
  const { lines, problems } = readWorkflow(workflow, file);
  return [...problems, ...permissionsProblems(lines, file)];
}
