import { describe, expect, it } from "vitest";
import type { Fact, Key } from "../catalog/index.ts";
import { HANDLING } from "./diff.ts";
import type { Handling, HandlingTable } from "./handling.ts";

/** A kind the diff doesn't know yet, such as a domain kind. */
type Domain = {
  readonly kind: "domain";
  readonly name: string;
  readonly parent: Key;
  readonly payload: { readonly columns: readonly string[] };
};
type Future = Fact | Domain;

const stated: Handling<Domain> = {
  parentDropCovers: true,
  drop: () => [],
  parentCreateCovers: false,
  create: () => [],
  replacedOnChange: true,
  alter: () => [],
  columnsNamed: (fact) => fact.payload.columns,
};

describe("the handling of each fact kind", () => {
  it("fails to compile until a new kind states every decision", () => {
    const complete: HandlingTable<Future> = { ...HANDLING, domain: stated };

    // @ts-expect-error -- no handling at all for the new kind.
    const none: HandlingTable<Future> = { ...HANDLING };

    // @ts-expect-error -- no statement of whether a dropped parent covers its drop.
    const noDrop: HandlingTable<Future> = { ...HANDLING, domain: omit(stated, "parentDropCovers") };

    const noCreate: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of whether a new parent creates it inline.
      domain: omit(stated, "parentCreateCovers"),
    };

    // @ts-expect-error -- no altered comparison.
    const noAlter: HandlingTable<Future> = { ...HANDLING, domain: omit(stated, "alter") };

    const noReplaced: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of whether a changed payload replaces it.
      domain: omit(stated, "replacedOnChange"),
    };

    const noColumns: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of which columns it names, so a rebuilt one drops it.
      domain: omit(stated, "columnsNamed"),
    };

    expect([complete, none, noDrop, noCreate, noAlter, noReplaced, noColumns]).toHaveLength(7);
  });
});

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}
