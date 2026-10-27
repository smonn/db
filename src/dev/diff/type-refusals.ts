import { elementOf, qualified, unchangedFacts, type Catalog, type Fact } from "../catalog/index.ts";
import { enumSwaps } from "./enum-swap.ts";
import { storageOf } from "./generation.ts";

type Catalogs = { readonly from: Catalog; readonly to: Catalog };
type Domain = Extract<Fact, { readonly kind: "domain" }>;

const WROTE_NONE = "Generate wrote no migration";

/**
 * Refuses the type changes no migration generate writes can make: a name that switches between
 * an enum and a domain, a domain's changed base type, and an enum swap under a domain that stays
 * (ADR-0023). A hand edit is the way through, so generate calls this only without one.
 */
export function refuseTypeChanges(catalogs: Catalogs): void {
  const staying: Domain[] = [];
  for (const [key, before] of catalogs.from) {
    const after = catalogs.to.get(key);
    if (after === undefined) continue;
    refuseKindSwitch(before, after, catalogs.from);
    if (before.kind === "domain" && after.kind === "domain") {
      refuseNewBase(before, after, catalogs);
      staying.push(before);
    }
  }
  refuseSwapUnderDomains(catalogs, staying);
  refuseSwapUnderGeneratedColumns(catalogs);
}

const ARTICLES: Readonly<Record<string, string>> = { enum: "an enum", domain: "a domain" };

/** The new type is created in "create or alter schema or type" and the old one drops in "drop type", so their names would clash. */
function refuseKindSwitch(before: Fact, after: Fact, from: Catalog): void {
  const now = ARTICLES[after.kind];
  if (!Object.hasOwn(ARTICLES, before.kind) || now === undefined || before.kind === after.kind) {
    return;
  }
  throw new Error(
    `Generate can't replace the ${before.kind} ${qualified(before, from)} with ${now} of the same name in one migration: it creates types before it drops them, so the two would clash. ${WROTE_NONE}: remove the ${before.kind} from the Definition and commit that migration, then add the ${after.kind}.`,
  );
}

function refuseNewBase(before: Domain, after: Domain, { from }: Catalogs): void {
  if (before.payload.base === after.payload.base) return;
  throw new Error(
    `Generate can't change the base type of the domain ${qualified(before, from)} from ${before.payload.base} to ${after.payload.base}: Postgres has no ALTER DOMAIN for it. ${WROTE_NONE}: write this one by hand, retyping each column off the domain, dropping it, and creating it again over the new base, or give the new domain another name.`,
  );
}

/**
 * Postgres can't move a domain to another base type, so a domain on a swapped enum keeps the old
 * type from dropping. A domain that drops in the same migration goes before the old type does.
 * `staying` holds the domains both catalogs have, as `from` has them.
 */
function refuseSwapUnderDomains(catalogs: Catalogs, staying: readonly Domain[]): void {
  for (const [type, { before }] of enumSwaps(catalogs)) {
    const domains = staying.filter((domain) => domain.payload.base === type);
    if (domains.length === 0) continue;
    throw new Error(
      `Generate can't remove or reorder a label of the enum ${qualified(before, catalogs.from)} while a domain depends on it: ${domains.map((fact) => qualified(fact, catalogs.from)).join(", ")}. Postgres can't move a domain to a new type, so the swap couldn't drop the old one. ${WROTE_NONE}: write this one by hand, dropping each domain before the swap and creating it again after, or drop the domains in an earlier migration.`,
    );
  }
}

/**
 * Postgres rejects `USING` on a generated column, and the swap retypes with one. A stored column
 * that stays generated can't move; one the Definition makes plain loses its expression first.
 */
function refuseSwapUnderGeneratedColumns(catalogs: Catalogs): void {
  const { from, to } = catalogs;
  const kept = unchangedFacts(from, to, "column");
  for (const [type, { before }] of enumSwaps(catalogs)) {
    const columns = kept
      .filter(
        ([column, after]) =>
          holds(column.payload.type, after.payload.type, type) &&
          isStored(from, column) &&
          isStored(to, after),
      )
      .map(([column]) => column);
    if (columns.length === 0) continue;
    throw new Error(
      `Generate can't remove or reorder a label of the enum ${qualified(before, from)} while a stored generated column has its type: ${columns.map((column) => qualified(column, from)).join(", ")}. Postgres can't retype a generated column with USING, which the swap needs. ${WROTE_NONE}: write this one by hand, dropping each column before the swap and adding it again after, or drop the columns in an earlier migration.`,
    );
  }
}

/** Whether a column keeps its type, which is `type` or an array of it. */
function holds(before: string, after: string, type: string): boolean {
  return before === after && (elementOf(before) ?? before) === type;
}

function isStored(catalog: Catalog, column: Fact): boolean {
  return storageOf(catalog, column) === "stored";
}
