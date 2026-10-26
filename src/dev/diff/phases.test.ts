import { describe, expect, it } from "vitest";
import type { ActionKind } from "./actions.ts";
import { PLACES, type PlaceTable } from "./phases.ts";

/** A kind the diff doesn't have yet, such as the table rename #448 adds. */
type Future = ActionKind | "rename table";

describe("the place of each action kind", () => {
  it("fails to compile until a new kind names its phase", () => {
    const complete: PlaceTable<Future> = { ...PLACES, "rename table": ["rename", 0] };

    // @ts-expect-error -- no place for the new kind.
    const none: PlaceTable<Future> = { ...PLACES };

    // @ts-expect-error -- a phase the phase table doesn't list.
    const unlisted: PlaceTable<Future> = { ...PLACES, "rename table": ["renames", 0] };

    expect([complete, none, unlisted]).toHaveLength(3);
  });
});
