import { describe, expect, it } from "vitest";
import type { ActionKind } from "./actions.ts";
import { PLACES, type PlaceTable } from "./phases.ts";

/** A kind the diff doesn't have yet, such as a view rename. */
type Future = ActionKind | "rename view";

describe("the place of each action kind", () => {
  it("fails to compile until a new kind names its phase", () => {
    const complete: PlaceTable<Future> = { ...PLACES, "rename view": ["rename", 1] };

    // @ts-expect-error -- no place for the new kind.
    const none: PlaceTable<Future> = { ...PLACES };

    // @ts-expect-error -- a phase the phase table doesn't list.
    const unlisted: PlaceTable<Future> = { ...PLACES, "rename view": ["renames", 0] };

    expect([complete, none, unlisted]).toHaveLength(3);
  });
});
