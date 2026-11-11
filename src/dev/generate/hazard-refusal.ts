import { CURRENT_FILENAME } from "../../runtime/internal/index.ts";
import { HAZARD_KINDS, type HazardKind } from "../diff/index.ts";
import { hazardsIn, strayHazardComments } from "./hazards.ts";

/** `commit` found Hazard kinds in `current.sql` that `--accept` doesn't name. */
export class HazardNotAcceptedError extends Error {
  readonly kinds: readonly HazardKind[];

  constructor(message: string, kinds: readonly HazardKind[]) {
    super(message);
    this.kinds = kinds;
  }
}

function isKnown(kind: string): kind is HazardKind {
  return HAZARD_KINDS.some((known) => known === kind);
}

/**
 * Why `commit` refuses (ADR-0015), or undefined when `accepted` names every Hazard kind in the
 * Current migration's body. It groups the missing kinds by statement and prints the full
 * `--accept` flag to pass. A kind that isn't one of ours is a typo in a hand edit, so the refusal
 * names it apart from the flag, which could never accept it. A line that looks like a Hazard
 * comment but isn't read as one would drop its gate by accident, so it refuses too.
 */
export function hazardRefusal(body: string, accepted: readonly string[]): string | undefined {
  const { missing, unknown } = groupHazards(body, accepted);
  const strays = strayHazardComments(body);
  if (missing.size === 0 && unknown.size === 0 && strays.length === 0) return undefined;
  return refusalLines(missing, unknown, strays, accepted).join("\n");
}

/**
 * The error `commit` throws for `hazardRefusal`'s message, or undefined without one. It is a
 * `HazardNotAcceptedError` naming the missing kinds when any is missing, and a plain error when
 * the refusal is only a typo'd kind or a stray comment, which `--accept` can't fix.
 */
export function hazardRefusalError(body: string, accepted: readonly string[]): Error | undefined {
  const message = hazardRefusal(body, accepted);
  if (message === undefined) return undefined;
  const kinds = [...new Set([...groupHazards(body, accepted).missing.values()].flat())];
  return kinds.length === 0 ? new Error(message) : new HazardNotAcceptedError(message, kinds);
}

function refusalLines(
  missing: ReadonlyMap<string, HazardKind[]>,
  unknown: ReadonlySet<string>,
  strays: readonly { line: number; text: string }[],
  accepted: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const { line, text } of strays) {
    lines.push(
      `${CURRENT_FILENAME}:${line} looks like a Hazard comment but isn't one: ${JSON.stringify(text)}; use "-- hazard: <kind>" above a statement or delete the line`,
    );
  }
  if (missing.size > 0) {
    lines.push(`${CURRENT_FILENAME} has Hazards that --accept doesn't name:`);
    for (const [statement, kinds] of missing) lines.push(`  ${kinds.join(", ")}: ${statement}`);
  }
  for (const kind of unknown) {
    lines.push(
      `unknown Hazard kind ${JSON.stringify(kind)} in ${CURRENT_FILENAME}; fix or delete the comment`,
    );
  }
  if (missing.size > 0) lines.push(acceptHint(accepted, missing));
  return lines;
}

function acceptHint(
  accepted: readonly string[],
  missing: ReadonlyMap<string, HazardKind[]>,
): string {
  const flag = new Set([...accepted, ...[...missing.values()].flat()]);
  return `to commit anyway, pass --accept ${[...flag].join(",")}`;
}

function groupHazards(
  body: string,
  accepted: readonly string[],
): { missing: Map<string, HazardKind[]>; unknown: Set<string> } {
  const missing = new Map<string, HazardKind[]>();
  const unknown = new Set<string>();
  for (const { kind, statement } of hazardsIn(body)) {
    if (!isKnown(kind)) unknown.add(kind);
    else if (!accepted.includes(kind)) {
      const kinds = missing.get(statement);
      if (kinds === undefined) missing.set(statement, [kind]);
      else kinds.push(kind);
    }
  }
  return { missing, unknown };
}
