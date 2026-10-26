import { assert, describe, expect, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable } from "./definition.ts";
import type { ColumnFactories } from "./factories.ts";
import type { Target } from "./references.ts";
import type { ColumnRefs } from "./refs.ts";

const pair = (c: ColumnFactories) => ({ id: c.integer().primaryKey(), p: c.integer() });

const shipments = defineTable(
  (c) => ({ region: c.text().notNull(), number: c.integer().notNull(), note: c.text() }),
  (t) => ({ primaryKey: [t.region, t.number] }),
);

const users = defineTable((c) => ({ id: c.integer().primaryKey() }));

const withEntries = (foreignKeys: unknown) =>
  defineTable(
    (c) => ({ a: c.text().notNull(), b: c.integer().notNull() }),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a caller that bypasses the types.
    () => ({ foreignKeys }) as never,
  );

describe("defineTable foreignKeys checks", () => {
  it("rejects a foreignKeys that is no list, an entry that is no object, and an unknown key", () => {
    expect(() => withEntries({})).toThrow(TypeError);
    expect(() => withEntries([1])).toThrow(TypeError);
    expect(() => withEntries([{ columns: [], references: [], nope: 1 }])).toThrow(
      'The table\'s foreignKeys does not take "nope"',
    );
  });

  it("rejects an entry with no columns or no references", () => {
    expect(() => withEntries([{ references: [] }])).toThrow(
      "The table's foreignKeys entry lists no columns",
    );
    expect(() =>
      defineTable(pair, (t) => ({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a caller that bypasses the types.
        foreignKeys: [{ columns: [t.p], references: [] as never }],
      })),
    ).toThrow("The table's foreignKeys entry lists no references");
  });

  it("rejects a column that is not one of the table's own", () => {
    expect(() => withEntries([{ columns: ["a"], references: [] }])).toThrow(
      "The table's foreignKeys names something that is not one of its columns",
    );
    const held: { refs?: ColumnRefs<ReturnType<typeof pair>> } = {};
    defineTable(pair, (t) => {
      held.refs = t;
      return {};
    });
    const foreign = held.refs;
    assert(foreign !== undefined);
    // The types compare tables by their columns, so only the load check catches a table with the same ones.
    expect(() =>
      defineTable(pair, (t) => ({ foreignKeys: [{ columns: [foreign.p], references: [t.id] }] })),
    ).toThrow('The table\'s foreignKeys takes "p" from another table');
  });

  it("rejects a column listed twice on either side", () => {
    expect(() =>
      defineTable(
        (c) => ({ id: c.integer().primaryKey(), p: c.integer() }),
        (t) => ({ foreignKeys: [{ columns: [t.p, t.p], references: [t.id, t.id] }] }),
      ),
    ).toThrow('The table\'s foreignKeys entry lists "p" twice in its columns');
    expect(() =>
      defineTable(
        (c) => ({ id: c.integer().primaryKey(), p: c.integer(), q: c.integer() }),
        (t) => ({ foreignKeys: [{ columns: [t.p, t.q], references: [t.id, t.id] }] }),
      ),
    ).toThrow('The table\'s foreignKeys entry lists "id" twice in its references');
  });
});

describe("defineDatabase foreignKeys checks", () => {
  it("refuses a column count that differs, at load where types are bypassed", () => {
    const events = defineTable(
      (c) => ({ region: c.text().notNull(), number: c.integer().notNull() }),
      (t) => ({
        foreignKeys: [
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a caller that bypasses the types.
          { columns: [t.region, t.number], references: (() => [users.columns.id]) as never },
        ],
      }),
    );

    expect(() => defineDatabase({ public: { users, events } })).toThrow(
      'the foreign key on "public"."events" ("region", "number") lists 2 column(s) and its target 1',
    );
  });

  it("refuses a composite target that is not the target table's primary key, naming both tables", () => {
    const events = defineTable(
      (c) => ({ region: c.text().notNull(), note: c.text() }),
      (t) => ({
        foreignKeys: [
          {
            columns: [t.region, t.note],
            references: () => [shipments.columns.region, shipments.columns.note],
          },
        ],
      }),
    );

    expect(() => defineDatabase({ public: { shipments, events } })).toThrow(
      'the foreign key on "public"."events" ("region", "note") points at "public"."shipments" ("region", "note"), which is not the primary key of "public"."shipments"',
    );
  });

  it("refuses a composite target that spans two tables", () => {
    const events = defineTable(
      (c) => ({ a: c.text().notNull(), b: c.integer().notNull() }),
      (t) => ({
        foreignKeys: [
          {
            columns: [t.a, t.b],
            references: () => [shipments.columns.region, users.columns.id],
          },
        ],
      }),
    );

    expect(() => defineDatabase({ public: { shipments, users, events } })).toThrow(
      'the foreign key on "public"."events" ("a", "b") points at columns of more than one table',
    );
  });

  it("refuses a composite target outside the Database, naming the table that points at it", () => {
    const events = defineTable(
      (c) => ({ a: c.text().notNull(), b: c.integer().notNull() }),
      (t) => ({
        foreignKeys: [
          {
            columns: [t.a, t.b],
            references: () => [shipments.columns.region, shipments.columns.number],
          },
        ],
      }),
    );

    expect(() => defineDatabase({ public: { events } })).toThrow(
      'the foreign key on "public"."events" ("a", "b") points at a table that is not in the Database; add it to defineDatabase',
    );
  });

  it("refuses a single-column target that is no key", () => {
    const events = defineTable(
      (c) => ({ region: c.text() }),
      (t) => ({
        foreignKeys: [
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a caller that bypasses the types.
          { columns: [t.region], references: (() => [shipments.columns.region]) as never },
        ],
      }),
    );

    expect(() => defineDatabase({ public: { shipments, events } })).toThrow(
      'the foreign key on "public"."events" ("region") points at "public"."shipments" ("region"), which is not a primary key or unique column',
    );
  });

  it("refuses a self reference to a column that is no key", () => {
    const nodes = defineTable(
      (c) => ({ id: c.integer().primaryKey(), parent_id: c.integer(), label: c.integer() }),
      (t) => ({
        foreignKeys: [
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a caller that bypasses the types.
          { columns: [t.parent_id], references: [t.label] as never },
        ],
      }),
    );

    expect(() => defineDatabase({ public: { nodes } })).toThrow(
      'the foreign key on "public"."nodes" ("parent_id") points at "public"."nodes" ("label"), which is not a primary key or unique column',
    );
  });

  it("refuses a column-level self reference, naming the table and the second callback", () => {
    const nodes = defineTable((c) => ({
      id: c.integer().primaryKey(),
      parent_id: c.integer().references((): Target<number> => nodes.columns.id),
    }));

    expect(() => defineDatabase({ public: { nodes } })).toThrow(
      'the foreign key on "public"."nodes" ("parent_id") points at its own table; declare a self reference in the table\'s second callback: foreignKeys: [{ columns: [t.parent_id], references: [t.id] }]',
    );
  });
});
