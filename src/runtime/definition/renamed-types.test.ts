import { describe, expect, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineDomain } from "./define-domain.ts";
import { defineEnum } from "./enum.ts";

describe("an enum's renames", () => {
  it("records the old name and the renamed labels, keyed new to old", () => {
    const mood = defineEnum(["great", "bad"], {
      renamedFrom: "old_mood",
      renamedLabels: { great: "good" },
    });

    expect(mood).toMatchObject({
      labels: ["great", "bad"],
      renamedFrom: "old_mood",
      renamedLabels: { great: "good" },
    });
  });

  it("has no renames by default", () => {
    expect(defineEnum(["a"])).toStrictEqual({
      kind: "enum",
      labels: ["a"],
      explicitName: undefined,
      renamedFrom: undefined,
      renamedLabels: {},
    });
  });

  it("types a renamed label as one of the enum's labels", () => {
    // @ts-expect-error -- "ghost" isn't one of the labels.
    const mood = defineEnum(["a"], { renamedLabels: { ghost: "a" } });

    expect(mood.renamedLabels).toStrictEqual({ ghost: "a" });
  });

  it("stays through defineDatabase", () => {
    const mood = defineEnum(["a"], { renamedFrom: "old_mood" });

    expect(defineDatabase({ public: { mood } }).public.mood.renamedFrom).toBe("old_mood");
  });
});

describe("a domain's rename", () => {
  it("records the old name", () => {
    const posint = defineDomain((c) => c.integer(), { renamedFrom: "old_posint" });

    expect(posint.renamedFrom).toBe("old_posint");
    expect(defineDomain((c) => c.integer()).renamedFrom).toBeUndefined();
  });
});
