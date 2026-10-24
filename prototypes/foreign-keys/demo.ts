/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway: loads each variant's Database and prints the foreign key facts and DDL.
import { isDeepStrictEqual } from "node:util";
import a from "./a-column/db.ts";
import b from "./b-table/db.ts";
import * as B from "./b-table/lib.ts";
import c from "./c-both/db.ts";
import { type ForeignKeyFact, render } from "./core.ts";
import d from "./d-database/db.ts";

const sorted = (facts: readonly ForeignKeyFact[]) =>
  facts.toSorted((x, y) => x.name.localeCompare(y.name));

const variants = { "A column": a, "B table": b, "C both": c, "D database": d };
for (const [name, { foreignKeys }] of Object.entries(variants)) {
  console.log(`\n== ${name}: ${foreignKeys.length} foreign keys`);
  for (const fact of sorted(foreignKeys)) console.log(render(fact));
}

console.log("\n== facts of B (every variant should match)");
console.log(JSON.stringify(sorted(b.foreignKeys), null, 2));

console.log("\n== what defineDatabase refuses");
const refused = (label: string, build: () => unknown) => {
  try {
    build();
    console.log(`${label}: ACCEPTED`);
  } catch (error) {
    console.log(`${label}: ${(error as Error).message}`);
  }
};
const loose = B.defineTable((c) => ({ id: c.integer().primaryKey() }));
const pointsAtLoose = B.defineTable(
  (c) => ({ x: c.integer() }),
  (t) => ({ foreignKeys: [{ columns: [t.x], references: () => [loose.columns.id] }] }),
);
refused("target outside the Database", () => B.defineDatabase({ public: { pointsAtLoose } }));
refused("one table rolled up twice", () =>
  B.defineDatabase({ public: { loose, pointsAtLoose }, archive: { loose } }),
);
const pair = B.defineTable((c) => ({ a: c.integer(), b: c.integer() }));
const pointsAtPair = B.defineTable(
  (c) => ({ a: c.integer(), b: c.integer() }),
  (t) => ({
    foreignKeys: [{ columns: [t.a, t.b], references: () => [pair.columns.a, pair.columns.b] }],
  }),
);
refused("composite target that isn't a key", () =>
  B.defineDatabase({ public: { pair, pointsAtPair } }),
);

const reference = sorted(b.foreignKeys);
for (const [name, { foreignKeys }] of Object.entries(variants)) {
  const ours = sorted(foreignKeys);
  // A can't express the self reference or the composite key, so it matches the subset it can.
  const expected = name.startsWith("A")
    ? reference.filter((f) => ours.some((o) => o.name === f.name))
    : reference;
  console.log(`${name}: ${isDeepStrictEqual(ours, expected) ? "matches" : "DIFFERS"}`);
}
