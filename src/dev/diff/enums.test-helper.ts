import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog, type Catalog, type Fact, type Key } from "../catalog/index.ts";

/** A Definition with one `public` schema holding `mood` with `labels` and a table that uses it. */
export function withMood(...labels: string[]): Catalog {
  const mood = defineEnum(labels);
  return definitionCatalog(
    defineDatabase({ public: { mood, users: defineTable((c) => ({ mood: c.enum(mood) })) } }),
  );
}

/** `catalog` with the enum `public.<name>` holding `labels`, for what the Definition can't declare. */
export function relabeled(catalog: Catalog, labels: readonly string[], name = "mood"): Catalog {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The brand exists only in types.
  const key = `public\0${name}` as Key;
  const fact = catalog.get(key);
  if (fact?.kind !== "enum") throw new Error(`no enum public.${name}`);
  const next: Fact = { ...fact, payload: { labels } };
  return new Map([...catalog].map(([at, existing]) => [at, at === key ? next : existing]));
}
