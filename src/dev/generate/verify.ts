import type { TrackingSchema } from "../../runtime/internal/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { payloadsEqual, qualified, type Catalog, type Fact } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { explainShadowError } from "./shadow-errors.ts";

/**
 * Applies the Current migration to the Shadow database and refuses, naming each remaining
 * difference, unless the Shadow then matches the Definition database's catalog (ADR-0013).
 */
export async function verifyInShadow(
  shadow: Driver,
  sql: string,
  definition: Catalog,
  tracking: TrackingSchema,
): Promise<void> {
  const leftover = await leftoverAfter(shadow, sql, definition, { tracking });
  if (leftover !== undefined) throw new Error(leftover);
}

/**
 * Applies the Current migration to the Shadow database, throwing on a SQL error, and returns the
 * message naming each remaining difference from the Definition, or `undefined` when none is left.
 */
export async function leftoverAfter(
  shadow: Driver,
  sql: string,
  definition: Catalog,
  context: { readonly tracking: TrackingSchema; readonly handEdited?: boolean },
): Promise<string | undefined> {
  try {
    await shadow.execute(sql);
  } catch (error) {
    throw explainShadowError(error, context.handEdited);
  }
  const remaining = differences(await introspect(shadow, context.tracking), definition);
  if (remaining.length === 0) return undefined;
  return `the Current migration leaves the Shadow database unlike the Definition database:\n${remaining
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

function differences(shadow: Catalog, definition: Catalog): string[] {
  const lines: string[] = [];
  for (const [key, fact] of shadow) {
    const wanted = definition.get(key);
    if (wanted === undefined) {
      lines.push(`${describe(fact, shadow)} is only in the Shadow database`);
    } else if (!payloadsEqual(fact.payload, wanted.payload)) {
      lines.push(
        `${describe(fact, shadow)} is ${JSON.stringify(fact.payload)} in the Shadow database and ${JSON.stringify(wanted.payload)} in the Definition database`,
      );
    }
  }
  for (const [key, fact] of definition) {
    if (!shadow.has(key))
      lines.push(`${describe(fact, definition)} is missing from the Shadow database`);
  }
  return lines;
}

function describe(fact: Fact, catalog: Catalog): string {
  return `${fact.kind} ${qualified(fact, catalog)}`;
}
