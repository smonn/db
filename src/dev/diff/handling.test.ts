import { describe, expect, it } from "vitest";
import type { Fact, Key } from "../catalog/index.ts";
import { HANDLING, type Handling, type HandlingTable } from "./diff.ts";

/** A kind the diff doesn't know yet, such as the index kind #376 adds. */
type Index = {
  readonly kind: "index";
  readonly name: string;
  readonly parent: Key;
  readonly payload: { readonly columns: readonly string[] };
};
type Future = Fact | Index;

const stated: Handling<Index> = {
  parentDropCovers: true,
  drop: () => [],
  parentCreateCovers: false,
  create: () => [],
  alter: () => [],
};

describe("the handling of each fact kind", () => {
  it("fails to compile until a new kind states every decision", () => {
    const complete: HandlingTable<Future> = { ...HANDLING, index: stated };

    // @ts-expect-error -- no handling at all for the new kind.
    const none: HandlingTable<Future> = { ...HANDLING };

    // @ts-expect-error -- no statement of whether a dropped parent covers its drop.
    const noDrop: HandlingTable<Future> = { ...HANDLING, index: omit(stated, "parentDropCovers") };

    const noCreate: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of whether a new parent creates it inline.
      index: omit(stated, "parentCreateCovers"),
    };

    // @ts-expect-error -- no altered comparison.
    const noAlter: HandlingTable<Future> = { ...HANDLING, index: omit(stated, "alter") };

    expect([complete, none, noDrop, noCreate, noAlter]).toHaveLength(5);
  });
});

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}
