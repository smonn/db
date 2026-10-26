import type { Enum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";

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

function quotedNames(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(".");
}
