import type { Fact } from "../catalog/index.ts";
import { enumSwap } from "./enum-swap.ts";
import type { HandlingTable } from "./handling.ts";

type TypeFact = Extract<Fact, { readonly kind: "enum" }>;

/** The handling of the types a schema holds beside its tables. */
export const TYPE_HANDLING: HandlingTable<TypeFact> = {
  enum: {
    // Postgres refuses to drop a schema that holds a type, so the type drops on its own.
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop enum", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "create enum", fact }],
    replacedOnChange: false,
    // An added label is one statement. Postgres can't drop or move one, so a removed or moved
    // label swaps the type, and `column.alter` retypes each column that uses it.
    alter: (before, after, catalogs) => {
      const swap = enumSwap(before, catalogs);
      if (swap !== undefined) {
        return [
          { kind: "rename enum aside", fact: before, swap },
          { kind: "create enum", fact: after },
          { kind: "drop enum aside", fact: before, swap },
        ];
      }
      return after.payload.labels
        .filter((label) => !before.payload.labels.includes(label))
        .map((label) => ({ kind: "add enum value", fact: after, before, label }));
    },
    columnsNamed: () => [],
  },
};
