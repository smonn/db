import { childrenOf, type Catalog, type Fact, type GeneratedPayload } from "../catalog/index.ts";

/** How the column stores its generation expression, or `undefined` when it isn't generated. */
export function storageOf(catalog: Catalog, column: Fact): GeneratedPayload["storage"] | undefined {
  for (const fact of childrenOf(catalog, column)) {
    if (fact.kind === "generated") return fact.payload.storage;
  }
  return undefined;
}
