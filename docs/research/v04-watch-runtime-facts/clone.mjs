/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Run with `node clone.ts` from this folder inside the repo. Can a Definition cross a Worker boundary by structured clone?
import { defineDatabase, defineTable } from "../../../src/runtime/definition/index.ts";
import { plainDate } from "../../../src/runtime/definition/plain-date.ts";

const plain = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text().primaryKey(), name: c.text() })) },
});
const withCodec = defineDatabase({
  public: {
    visits: defineTable((c) => ({
      id: c.text().primaryKey(),
      day: c.date().codec(plainDate).notNull(),
    })),
  },
});
for (const [label, db] of [
  ["plain definition", plain],
  ["definition with a codec", withCodec],
]) {
  try {
    const copy = structuredClone(db);
    console.log(
      label,
      "-> structuredClone OK; SQL view symbol kept:",
      Object.getOwnPropertySymbols(copy).length > 0,
    );
  } catch (e) {
    console.log(label, "-> structuredClone FAIL", e.name, e.message.split("\n")[0]);
  }
}

const { definitionCatalog } = await import("../../../src/dev/catalog/definition-catalog.ts");
for (const [label, db] of [
  ["plain definition", plain],
  ["definition with a codec", withCodec],
]) {
  try {
    structuredClone(definitionCatalog(db));
    console.log(label, "-> definitionCatalog(db) structuredClone OK");
  } catch (e) {
    console.log(
      label,
      "-> definitionCatalog(db) structuredClone FAIL",
      e.name,
      e.message.split("\n")[0],
    );
  }
}
