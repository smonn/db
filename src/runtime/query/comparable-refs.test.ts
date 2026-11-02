import { describe, expect, it } from "vitest";
import { defineDatabase, defineEnum, defineTable } from "../definition/index.ts";
import { assertComparableRefs, refsOf } from "./refs.ts";

const { items } = defineDatabase({
  public: {
    items: defineTable((c) => ({
      mood: c.enum(defineEnum(["sad", "ok"])),
      tone: c.enum(defineEnum(["sad", "ok"])),
    })),
  },
}).public;
const refs = refsOf<{ mood: unknown; tone: unknown }>(items);

describe("assertComparableRefs", () => {
  it("throws for two refs Postgres won't compare", () => {
    expect(() => {
      assertComparableRefs(refs.mood, refs.tone);
    }).toThrow(`Can't compare "items"."mood" with "items"."tone"`);
  });

  it("passes a value that is no ref, on either side", () => {
    expect(() => {
      assertComparableRefs(refs.mood, "sad");
      assertComparableRefs("sad", refs.tone);
    }).not.toThrow();
  });
});
