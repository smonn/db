import type { Enum } from "../../runtime/definition/index.ts";
import { isEnum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { typeName } from "./column-type.ts";

const MAX_LABEL_BYTES = 63;

/** Refuses the labels Postgres would reject or truncate; a zero-label enum is allowed, as it is there. */
export function labelsOf(schema: string, name: string, { labels }: Enum): readonly string[] {
  const seen = new Set<string>();
  for (const label of labels) {
    const where = `Enum ${quotedNames([schema, name])}`;
    if (label === "") throw new Error(`${where} has an empty label`);
    if (seen.has(label)) throw new Error(`${where} lists the label ${JSON.stringify(label)} twice`);
    if (new TextEncoder().encode(label).length > MAX_LABEL_BYTES) {
      throw new Error(
        `${where} has the label ${JSON.stringify(label)}, which is over ${MAX_LABEL_BYTES} bytes; Postgres would refuse it`,
      );
    }
    seen.add(label);
  }
  return [...labels];
}

/** Each enum's type name, found by the identity of the value its columns hold. */
export function enumTypeNames(definition: {
  readonly [schema: string]: { readonly [name: string]: unknown };
}): ReadonlyMap<Enum, string> {
  const found = new Map<Enum, { readonly schema: string; readonly name: string }>();
  for (const [schema, entries] of Object.entries(definition)) {
    for (const [name, entry] of Object.entries(entries)) {
      if (!isEnum(entry)) continue;
      const other = found.get(entry);
      if (other !== undefined) {
        throw new Error(
          `One enum is rolled up as ${quotedNames([other.schema, other.name])} and ${quotedNames([schema, name])}; give each its own defineEnum`,
        );
      }
      found.set(entry, { schema, name });
    }
  }
  return new Map([...found].map(([entry, { schema, name }]) => [entry, typeName(schema, name)]));
}

function quotedNames(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(".");
}
