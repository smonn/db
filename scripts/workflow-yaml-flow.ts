/**
 * Reads the quoted scalars and flow collections of one workflow line for scripts/workflow-yaml.ts,
 * throwing `Unreadable` on any form that check refuses.
 */
export class Unreadable extends Error {}

export const indentOf = (text: string): number => text.length - text.trimStart().length;
export const skipSpaces = (text: string, at: number): number => {
  let index = at;
  while (text[index] === " ") index += 1;
  return index;
};
export const endsLine = (text: string, at: number): boolean =>
  at >= text.length || text[at] === "#";

const nodeForms: Record<string, string> = {
  "?": "an explicit key (?)",
  "&": "an anchor (&)",
  "*": "an alias (*)",
  "!": "a tag (!)",
};

export function refuseNodeStart(text: string, at: number): void {
  const form = nodeForms[text[at] ?? ""];
  if (form !== undefined) throw new Unreadable(form);
}

function refuseEscape(quote: string | undefined, char: string | undefined): void {
  if (quote === '"' && char === "\\") throw new Unreadable("an escape in a double-quoted scalar");
}

const isDoubledQuote = (text: string, index: number, quote: string | undefined): boolean =>
  quote === "'" && text[index + 1] === "'";

export function quotedEnd(text: string, at: number): number {
  const quote = text[at];
  for (let index = at + 1; index < text.length; index += 1) {
    refuseEscape(quote, text[index]);
    if (text[index] !== quote) continue;
    if (isDoubledQuote(text, index, quote)) index += 1;
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

function flowKeyBefore(text: string, start: number, end: number, close: string): string | null {
  // A key with no colon is still a key in a flow map: `{a, b}` reads as `{a: null, b: null}`.
  const bare = close === "}" && (text[end] === "," || text[end] === close);
  if (text[end] !== ":" && !bare) return null;
  return text
    .slice(start, end)
    .trim()
    .replace(/^(["'])(.*)\1$/u, "$2");
}

function refuseFlowEnd(text: string, position: number): void {
  if (endsLine(text, position)) throw new Unreadable("a flow collection across lines");
}

function flowValueEnd(text: string, colon: number, close: string, keys: string[]): number {
  const index = skipSpaces(text, colon + 1);
  refuseFlowEnd(text, index);
  if (text[index] === "," || text[index] === close) return index;
  return skipSpaces(text, flowNodeEnd(text, index, keys));
}

function flowEntryEnd(text: string, start: number, close: string, keys: string[]): number {
  const index = skipSpaces(text, flowNodeEnd(text, start, keys));
  const key = flowKeyBefore(text, start, index, close);
  if (key !== null) keys.push(key);
  return text[index] === ":" ? flowValueEnd(text, index, close, keys) : index;
}

export function flowEnd(text: string, at: number, keys: string[]): number {
  const close = text[at] === "{" ? "}" : "]";
  let index = skipSpaces(text, at + 1);
  while (text[index] !== close) {
    refuseFlowEnd(text, index);
    index = flowEntryEnd(text, index, close, keys);
    refuseFlowEnd(text, index);
    if (text[index] === ",") index = skipSpaces(text, index + 1);
    else if (text[index] !== close) throw new Unreadable("a malformed flow collection");
  }
  return index + 1;
}

export function refuseTrailing(text: string, at: number, after: string): void {
  if (!endsLine(text, skipSpaces(text, at))) throw new Unreadable(`text after ${after}`);
}
