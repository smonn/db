import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { asideName, enumSwaps, SWAP_STEPS, type Swap } from "./enum-swap.ts";

const FROM = ["a", "b", "c"];
const TO = ["c", "b", "a"];

/** Each of `enums` (schema, name) holding `labels`, with its schema. */
function enumsWith(enums: readonly [string, string][], labels: readonly string[]): Catalog {
  const builder: CatalogBuilder = catalogBuilder();
  for (const schema of new Set(enums.map(([inSchema]) => inSchema))) builder.schema(schema);
  for (const [schema, name] of enums) builder.enumType(schema, name, { labels });
  return builder.build();
}

const asides = (enums: readonly [string, string][]): string[] =>
  [...enumSwaps({ from: enumsWith(enums, FROM), to: enumsWith(enums, TO) }).values()].map(
    (swap) => swap.aside,
  );

describe("the aside of each enum swap", () => {
  it("gives two names that shorten to one aside different ones in a schema", () => {
    const base = "m".repeat(60);

    expect(
      asides([
        ["public", `${base}x`],
        ["public", `${base}y`],
      ]),
    ).toStrictEqual([`${"m".repeat(59)}_old`, `${"m".repeat(58)}_old1`]);
  });

  it("lets two schemas each use the same aside", () => {
    expect(
      asides([
        ["one", "mood"],
        ["two", "mood"],
      ]),
    ).toStrictEqual(["mood_old", "mood_old"]);
  });
});

/** The swap of `public.mood` from `a, b, c` to `c, b, a`. */
function moodSwap(): Swap {
  const swaps = enumSwaps({
    from: enumsWith([["public", "mood"]], FROM),
    to: enumsWith([["public", "mood"]], TO),
  });
  return [...swaps.values()][0]!;
}

describe("asideName", () => {
  it("starts from _old when the catalogs lack the type's schema", () => {
    expect(asideName(moodSwap().before, [catalogBuilder().build()], [])).toBe("mood_old");
  });
});

describe("the swap steps that only rename or drop the old type", () => {
  it("carry no hazard", () => {
    const swap = moodSwap();

    expect(SWAP_STEPS["rename enum aside"].hazards({ swap })).toStrictEqual([]);
    expect(SWAP_STEPS["drop enum aside"].hazards({ swap })).toStrictEqual([]);
  });
});
