import { quoteIdentifier } from "../../runtime/internal/index.ts";
import {
  childrenOf,
  elementOf,
  parentOf,
  qualified,
  typeName,
  type Catalog,
  type Fact,
  type Key,
} from "../catalog/index.ts";
import { REWRITE, type HazardKind } from "./hazards.ts";
import { alterColumn, type FactOf } from "./statements.ts";

type EnumFact = Extract<Fact, { readonly kind: "enum" }>;
type Catalogs = { readonly from: Catalog; readonly to: Catalog };

/**
 * An enum whose labels `ADD VALUE` can't reach, since one was removed or moved: the old type
 * renames to `aside`, a new one takes its name, and each column using it retypes (ADR-0023).
 */
export type Swap = {
  /** The enum as `from` has it. */
  readonly before: EnumFact;
  readonly after: EnumFact;
  /** The name the old type takes while its columns move to the new one. */
  readonly aside: string;
  /** Whether a label is gone, so a row holding it can't convert. */
  readonly removesLabel: boolean;
};

/** The enum swaps between two catalogs, keyed by the type's name as a column's `type` spells it. */
export function enumSwaps(catalogs: Catalogs): ReadonlyMap<string, Swap> {
  const swaps = new Map<string, Swap>();
  for (const [key, before] of catalogs.from) {
    const after = catalogs.to.get(key);
    if (before.kind !== "enum" || after?.kind !== "enum") continue;
    const swap = enumSwap(before, after, catalogs);
    if (swap !== undefined) {
      swaps.set(typeName(parentOf(catalogs.from, before).name, before.name), swap);
    }
  }
  return swaps;
}

/** The swap from `before` to `after`, one enum at one key, or `undefined` when `ADD VALUE` suffices. */
export function enumSwap(
  before: EnumFact,
  after: EnumFact,
  { from, to }: Catalogs,
): Swap | undefined {
  if (inOrder(before.payload.labels, after.payload.labels)) return undefined;
  return {
    before,
    after,
    aside: asideName(before, [from, to]),
    removesLabel: before.payload.labels.some((label) => !after.payload.labels.includes(label)),
  };
}

/** The swap that retypes a column of `type`, an enum or an array of one, if any. */
export function swapOf(type: string, catalogs: Catalogs): Swap | undefined {
  return enumSwaps(catalogs).get(elementOf(type) ?? type);
}

/** Whether `labels` keep their relative order in `next`, so `ADD VALUE` can reach it. */
function inOrder(labels: readonly string[], next: readonly string[]): boolean {
  let position = 0;
  for (const label of next) if (label === labels[position]) position += 1;
  return position === labels.length;
}

const MAX_NAME_BYTES = 63;

/**
 * `<name>_old`, or `_old1`, `_old2`, and on while a table or type in the schema takes it, cut to
 * fit 63 bytes, since Postgres would truncate a longer name.
 */
function asideName(type: EnumFact, catalogs: readonly Catalog[]): string {
  const taken = new Set(catalogs.flatMap((catalog) => namesUnder(catalog, type.parent)));
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? "_old" : `_old${attempt}`;
    const candidate = `${fitting(type.name, MAX_NAME_BYTES - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function namesUnder(catalog: Catalog, schema: Key): readonly string[] {
  const parent = catalog.get(schema);
  return parent === undefined ? [] : childrenOf(catalog, parent).map((fact) => fact.name);
}

/** The longest start of `name` that fits in `bytes` of UTF-8, never splitting a character. */
function fitting(name: string, bytes: number): string {
  const encoder = new TextEncoder();
  let kept = "";
  for (const character of name) {
    if (encoder.encode(kept + character).length > bytes) break;
    kept += character;
  }
  return kept;
}

type Carrying = { readonly swap: Swap };

/** The shape of a step in `actions.ts`, which imports this module, so it can't import its type. */
type SwapStep<F> = {
  readonly render: (fact: F, catalogs: Catalogs, action: Carrying) => string;
  readonly hazards: (action: Carrying) => readonly HazardKind[];
};

/** The statements of a swap beside `create enum`, which creates the new type. */
export const SWAP_STEPS: {
  readonly "rename enum aside": SwapStep<EnumFact>;
  readonly "drop enum aside": SwapStep<EnumFact>;
  readonly "swap retype": SwapStep<FactOf<"column">>;
} = {
  // The old type only changes name while its columns move off it, so no app code sees it.
  "rename enum aside": {
    render: (type, { from }, { swap }) =>
      `alter type ${qualified(type, from)} rename to ${quoteIdentifier(swap.aside)};`,
    hazards: () => [],
  },
  "drop enum aside": {
    render: (type, { from }, { swap }) =>
      `drop type ${quoteIdentifier(parentOf(from, type).name)}.${quoteIdentifier(swap.aside)};`,
    hazards: () => [],
  },
  // The only retype generate writes a USING for: no cast joins two enums, but text reaches both.
  "swap retype": {
    render: (column, { to }) => {
      const { type } = column.payload;
      return `${alterColumn(column, to)} type ${type} using ${quoteIdentifier(column.name)}::text::${type};`;
    },
    // A row holding a removed label fails the statement, but ADR-0023 flags it as data loss.
    hazards: ({ swap }) => (swap.removesLabel ? ["data_loss", ...REWRITE] : REWRITE),
  },
};
