import { quoteIdentifier, type TrackingSchema } from "../../runtime/internal/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { namesOf, type Catalog, type Fact } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";

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
  await shadow.execute(sql);
  const remaining = differences(await introspect(shadow, tracking), definition);
  if (remaining.length === 0) return;
  throw new Error(
    `the Current migration leaves the Shadow database unlike the Definition database:\n${remaining
      .map((line) => `  ${line}`)
      .join("\n")}`,
  );
}

function differences(shadow: Catalog, definition: Catalog): string[] {
  const lines: string[] = [];
  for (const [key, fact] of shadow) {
    const wanted = definition.get(key);
    if (wanted === undefined) {
      lines.push(`${describe(fact, shadow)} is only in the Shadow database`);
    } else if (JSON.stringify(fact.payload) !== JSON.stringify(wanted.payload)) {
      // Both catalogs come from introspect, so equal payloads serialize with the same key order.
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
  return `${fact.kind} ${namesOf(catalog, fact)
    .map((name) => quoteIdentifier(name))
    .join(".")}`;
}
