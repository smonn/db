import { splitCurrentHeader, type TrackingSchema } from "../../runtime/internal/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { arePayloadsEqual, qualified, type Catalog, type Fact } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { explainShadowError } from "./shadow-errors.ts";

/**
 * Applies the Current migration to the Shadow database and refuses, naming each remaining
 * difference, unless the Shadow then matches the Definition database's catalog (ADR-0013).
 * Returns the Shadow's catalog with the Current migration applied.
 */
export async function verifyInShadow(
  shadow: Driver,
  sql: string,
  definition: Catalog,
  tracking: TrackingSchema,
): Promise<Catalog> {
  const after = await leftoverAfter(shadow, sql, definition, { tracking });
  if (after.leftover !== undefined) throw new Error(after.leftover);
  return after.shadow;
}

export type ShadowAfter = {
  /** The Shadow's catalog with the Current migration applied. */
  readonly shadow: Catalog;
  /** The message naming each remaining difference from the Definition, if any is left. */
  readonly leftover: string | undefined;
};

/** Applies the Current migration to the Shadow database, throwing on a SQL error. */
export async function leftoverAfter(
  shadow: Driver,
  sql: string,
  definition: Catalog,
  context: { readonly tracking: TrackingSchema; readonly handEdited?: boolean },
): Promise<ShadowAfter> {
  const { noTransaction } = splitCurrentHeader(sql);
  try {
    // Outside a transaction only for a no-transaction hand edit, so a statement that needs that
    // fails here, as it would in `migrate` and `reset`, unless the edit says so (ADR-0020).
    await (noTransaction ? shadow.execute(sql) : shadow.transaction((tx) => tx.execute(sql)));
  } catch (error) {
    throw explainShadowError(error, { handEdited: context.handEdited, noTransaction });
  }
  const after = await introspect(shadow, context.tracking);
  const remaining = differences(after, definition);
  if (remaining.length === 0) return { shadow: after, leftover: undefined };
  const leftover = `the Current migration leaves the Shadow database unlike the Definition database:\n${remaining
    .map((line) => `  ${line}`)
    .join("\n")}`;
  return { shadow: after, leftover };
}

function differences(shadow: Catalog, definition: Catalog): string[] {
  const lines: string[] = [];
  for (const [key, fact] of shadow) {
    const wanted = definition.get(key);
    if (wanted === undefined) {
      lines.push(`${describe(fact, shadow)} is only in the Shadow database`);
    } else if (!arePayloadsEqual(fact.payload, wanted.payload)) {
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
