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

type Key = NonNullable<WorkflowLine["key"]>;

class Unreadable extends Error {}

const indentOf = (text: string): number => text.length - text.trimStart().length;
const skipSpaces = (text: string, at: number): number => {
  let index = at;
  while (text[index] === " ") index += 1;
  return index;
};
const endsLine = (text: string, at: number): boolean => at >= text.length || text[at] === "#";

const nodeForms: Record<string, string> = {
  "?": "an explicit key (?)",
  "&": "an anchor (&)",
  "*": "an alias (*)",
  "!": "a tag (!)",
};

function refuseNodeStart(text: string, at: number): void {
  const form = nodeForms[text[at] ?? ""];
  if (form !== undefined) throw new Unreadable(form);
}

function quotedEnd(text: string, at: number): number {
  const quote = text[at];
  for (let index = at + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\")
      throw new Unreadable("an escape in a double-quoted scalar");
    if (text[index] !== quote) continue;
    if (quote === "'" && text[index + 1] === "'") index += 1;
    else return index + 1;
  }
  throw new Unreadable("a quoted scalar across lines");
}

const flowStop = /[,[\]{}]|:(?=[\s,[\]{}]|$)|\s#/u;

function flowNodeEnd(text: string, at: number, keys: string[]): number {
  refuseNodeStart(text, at);
  const char = text[at];
  if (char === "{" || char === "[") return flowEnd(text, at, keys);
  if (char === '"' || char === "'") return quotedEnd(text, at);
  const stop = flowStop.exec(text.slice(at));
  return stop === null ? text.length : at + stop.index;
}

function flowEnd(text: string, at: number, keys: string[]): number {
  const close = text[at] === "{" ? "}" : "]";
  let index = skipSpaces(text, at + 1);
  const refuseEnd = (position: number): void => {
    if (endsLine(text, position)) throw new Unreadable("a flow collection across lines");
  };
  while (text[index] !== close) {
    refuseEnd(index);
    const start = index;
    index = skipSpaces(text, flowNodeEnd(text, index, keys));
    // A key with no colon is still a key in a flow map: `{a, b}` reads as `{a: null, b: null}`.
    if (text[index] === ":" || (close === "}" && (text[index] === "," || text[index] === close))) {
      keys.push(
        text
          .slice(start, index)
          .trim()
          .replace(/^(["'])(.*)\1$/u, "$2"),
      );
    }
    if (text[index] === ":") {
      index = skipSpaces(text, index + 1);
      refuseEnd(index);
      if (text[index] !== "," && text[index] !== close)
        index = skipSpaces(text, flowNodeEnd(text, index, keys));
    }
    refuseEnd(index);
    if (text[index] === ",") index = skipSpaces(text, index + 1);
    else if (text[index] !== close) throw new Unreadable("a malformed flow collection");
  }
  return index + 1;
}

function refuseTrailing(text: string, at: number, after: string): void {
  if (!endsLine(text, skipSpaces(text, at))) throw new Unreadable(`text after ${after}`);
}

// Returns whether the value starts a block scalar.
function readValue(text: string, at: number, flowKeys: string[]): boolean {
  refuseNodeStart(text, at);
  const char = text[at];
  if (char === "|" || char === ">") {
    if (!/^[|>][-+0-9]*\s*(?:#.*)?$/u.test(text.slice(at)))
      throw new Unreadable("a block scalar header");
    return true;
  }
  if (char === "{" || char === "[")
    refuseTrailing(text, flowEnd(text, at, flowKeys), "a flow collection");
  else if (char === '"' || char === "'")
    refuseTrailing(text, quotedEnd(text, at), "a quoted scalar");
  return false;
}

const plainKey = /^([^#]*?)\s*:(?:\s|$)/u;

function readKey(text: string, at: number): { key: Key; next: number } | undefined {
  const char = text[at];
  if (char === "{" || char === "[") return undefined;
  if (char === '"' || char === "'") {
    const end = quotedEnd(text, at);
    const colon = skipSpaces(text, end);
    if (text[colon] !== ":") return undefined;
    return { key: { name: text.slice(at + 1, end - 1), column: at }, next: colon + 1 };
  }
  const rest = text.slice(at);
  const match = plainKey.exec(rest);
  if (match?.[1] === undefined) return undefined;
  return { key: { name: match[1], column: at }, next: at + match[0].length };
}

type Read = { line: WorkflowLine; scalarAbove?: number };

function readLine(number: number, text: string): Read {
  if (/^(?:---|\.\.\.)(?:\s|$)|^%/u.test(text))
    throw new Unreadable("a document marker or directive");
  let at = indentOf(text);
  let dash = -1;
  while (text[at] === "-" && (text[at + 1] === " " || at + 1 === text.length)) {
    dash = at;
    at = skipSpaces(text, at + 1);
  }
  const line: WorkflowLine = { number, indent: indentOf(text), value: "", flowKeys: [] };
  if (endsLine(text, at)) return { line };
  refuseNodeStart(text, at);
  const read = readKey(text, at);
  if (read !== undefined) {
    line.key = read.key;
    at = skipSpaces(text, read.next);
    if (endsLine(text, at)) return { line };
  }
  line.value = text
    .slice(at)
    .replace(/\s+#.*$/u, "")
    .trim();
  if (!readValue(text, at, line.flowKeys)) return { line };
  return { line, scalarAbove: read?.key.column ?? (dash === -1 ? line.indent : dash) };
}

export function workflowYamlProblems(workflow: string, file: string): string[] {
  const problems: string[] = [];
  const lines: WorkflowLine[] = [];
  let scalarAbove: number | undefined;
  for (const [index, text] of workflow.split("\n").entries()) {
    const number = index + 1;
    const outside = /[^ -~]/u.exec(text)?.[0];
    if (outside !== undefined) {
      const code = outside.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
      problems.push(
        `${file} line ${number} holds U+${code}, outside printable ASCII; this check reads printable ASCII only`,
      );
      continue;
    }
    if (scalarAbove !== undefined && (text.trim() === "" || indentOf(text) > scalarAbove)) continue;
    scalarAbove = undefined;
    if (text.trim() === "" || text.trimStart().startsWith("#")) continue;
    try {
      const read = readLine(number, text);
      scalarAbove = read.scalarAbove;
      lines.push(read.line);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      problems.push(`${file} line ${number} uses ${error.message}, which this check can't read`);
    }
  }
  return [...problems, ...permissionsProblems(lines, file)];
}
