/**
 * The one `Stryker disable` comment form the repo allows, and the inert marker the weekly Mutation
 * run swaps it for, so Stryker still runs the mutant it hides and `mutation-report.ts` can tell when
 * the comment has gone stale (#611). The allowed form is a `//` comment alone on its line, directly
 * above the line it covers: `Stryker disable next-line <Mutator>[, <Mutator>]: <N> survivors: <reason>`.
 *
 * The survivor count rides in the reason, which Stryker keeps as free text after the first colon, so
 * the comment stays a directive Stryker honors. A disable hides every mutant of its mutator on the
 * line, the killable twin of an equivalent mutant included; the count lets the weekly run report a
 * survivor beyond the ones the author reviewed.
 */

// The part of Stryker 10.1.1's parse (DirectiveBookkeeper in @stryker-mutator/instrumenter) that
// decides whether a comment is a directive; the rest of its pattern matches any text.
const STRYKER_DIRECTIVE = /^\s?Stryker (?:disable|restore)(?: next-line)? [a-zA-Z, ]/u;
const ALLOWED = /^ Stryker disable next-line ([A-Za-z]+(?:, [A-Za-z]+)*): [1-9]\d* survivors?: \S/u;
const DISABLE_LINE = /^([ \t]*)\/\/ Stryker disable next-line /gmu;
const MARKER = "// Stryker expect next-line ";
const MARKER_LINE = /^[ \t]*\/\/ Stryker expect next-line ([A-Za-z, ]+): ([1-9]\d*) survivors?:/u;
// Stryker matches every mutator for this name, in any case.
const WILDCARD = "all";

export const FORM_MESSAGE =
  "Write a Stryker directive as `// Stryker disable next-line <Mutator>: <N> survivors: <reason>`: a disable without next-line, a survivor count, or a reason can outlive the mutant it hides unseen";

const names = (list: string): string[] => list.split(",").map((name) => name.trim());

export const isStrykerDirective = (text: string): boolean => STRYKER_DIRECTIVE.test(text);

/** The problem with a comment's text, or undefined when Stryker ignores it or it has the allowed form. */
export function directiveProblem(text: string): string | undefined {
  if (!isStrykerDirective(text)) return undefined;
  const list = ALLOWED.exec(text)?.[1];
  if (list === undefined) return FORM_MESSAGE;
  if (names(list).some((name) => name.toLowerCase() === WILDCARD)) {
    return "Name the mutator this Stryker directive disables rather than all, so the weekly run can tell when it goes stale";
  }
  return undefined;
}

/** Swaps each allowed `Stryker disable` comment for a marker Stryker ignores, on the same line. */
export const markDisables = (text: string): string =>
  text.replaceAll(DISABLE_LINE, (_match, indent: string) => `${indent}${MARKER}`);

export type Disable = { line: number; mutators: string[]; expected: number };

/** Each marker in `source`: its 1-based line, the mutators it names, and the survivors it expects. */
export function markedDisables(source: string): Disable[] {
  return source.split("\n").flatMap((text, index) => {
    const match = MARKER_LINE.exec(text);
    if (match === null) return [];
    // Both groups capture whenever the pattern matches.
    return [{ line: index + 1, mutators: names(String(match[1])), expected: Number(match[2]) }];
  });
}
