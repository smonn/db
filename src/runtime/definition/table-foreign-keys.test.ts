import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "./definition.ts";
import type { Target } from "./references.ts";

const shipments = defineTable(
  (c) => ({ region: c.text().notNull(), number: c.integer().notNull(), note: c.text() }),
  (t) => ({ primaryKey: [t.region, t.number] }),
);

const users = defineTable((c) => ({
  id: c.integer().primaryKey(),
  email: c.text().unique(),
  name: c.text(),
}));

describe("foreignKeys in the second callback", () => {
  it("declares a composite foreign key to another table's primary key", () => {
    const events = defineTable(
      (c) => ({ region: c.text().notNull(), number: c.integer().notNull() }),
      (t) => ({
        foreignKeys: [
          {
            columns: [t.region, t.number],
            references: () => [shipments.columns.region, shipments.columns.number],
            name: "events_shipment",
            onDelete: "cascade",
            onUpdate: "restrict",
            match: "full",
            deferrable: "deferred",
          },
        ],
      }),
    );
    const db = defineDatabase({ public: { shipments, events } });

    expect(db.public.events.foreignKeys).toStrictEqual([
      {
        name: "events_shipment",
        columns: ["region", "number"],
        target: { schema: "public", table: "shipments", columns: ["region", "number"] },
        onDelete: "cascade",
        onUpdate: "restrict",
        match: "full",
        deferrable: "deferred",
      },
    ]);
  });

  it("takes the target's columns in the order written, paired by position", () => {
    const events = defineTable(
      (c) => ({ n: c.integer().notNull(), r: c.text().notNull() }),
      (t) => ({
        foreignKeys: [
          {
            columns: [t.n, t.r],
            references: () => [shipments.columns.number, shipments.columns.region],
          },
        ],
      }),
    );
    const db = defineDatabase({ public: { shipments, events } });

    expect(db.public.events.foreignKeys[0]).toMatchObject({
      columns: ["n", "r"],
      target: { columns: ["number", "region"] },
      match: "simple",
      deferrable: "not deferrable",
      onDelete: "no action",
    });
  });

  it("declares a self reference through the table's own references, with no annotation", () => {
    const nodes = defineTable(
      (c) => ({ id: c.integer().primaryKey(), parent_id: c.integer() }),
      (t) => ({
        foreignKeys: [{ columns: [t.parent_id], references: [t.id], onDelete: "set null" }],
      }),
    );
    const db = defineDatabase({ public: { nodes } });

    expect(db.public.nodes.foreignKeys).toStrictEqual([
      {
        name: undefined,
        columns: ["parent_id"],
        target: { schema: "public", table: "nodes", columns: ["id"] },
        onDelete: "set null",
        onUpdate: "no action",
        match: "simple",
        deferrable: "not deferrable",
      },
    ]);
  });

  it("declares a composite self reference to the table's composite primary key", () => {
    const parts = defineTable(
      (c) => ({
        a: c.integer().notNull(),
        b: c.integer().notNull(),
        parent_a: c.integer(),
        parent_b: c.integer(),
      }),
      (t) => ({
        primaryKey: [t.a, t.b],
        foreignKeys: [{ columns: [t.parent_a, t.parent_b], references: [t.a, t.b] }],
      }),
    );
    const db = defineDatabase({ public: { parts } });

    expect(db.public.parts.foreignKeys[0]).toMatchObject({
      columns: ["parent_a", "parent_b"],
      target: { schema: "public", table: "parts", columns: ["a", "b"] },
    });
  });

  it("lists a column's own foreign keys before the second callback's, and allows one column", () => {
    const orders = defineTable(
      (c) => ({
        id: c.integer().primaryKey(),
        user_id: c.integer().references(() => users.columns.id),
        email: c.text(),
      }),
      (t) => ({
        foreignKeys: [{ columns: [t.email], references: () => [users.columns.email] }],
      }),
    );
    const db = defineDatabase({ public: { users, orders } });

    expect(db.public.orders.foreignKeys.map(({ columns }) => columns)).toStrictEqual([
      ["user_id"],
      ["email"],
    ]);
  });

  it("loads in either order, since another table's columns are read late", () => {
    const early = defineTable(
      (c) => ({ id: c.integer().primaryKey(), late_id: c.integer() }),
      (t) => ({
        foreignKeys: [
          { columns: [t.late_id], references: (): [Target<number>] => [late.columns.id] },
        ],
      }),
    );
    const late = defineTable(
      (c) => ({ id: c.integer().primaryKey(), early_id: c.integer() }),
      (t) => ({ foreignKeys: [{ columns: [t.early_id], references: () => [early.columns.id] }] }),
    );
    const db = defineDatabase({ public: { early, late } });

    expect(db.public.early.foreignKeys[0]?.target.table).toBe("late");
    expect(db.public.late.foreignKeys[0]?.target.table).toBe("early");
  });
});

describe("foreignKeys types", () => {
  it("rejects a count mismatch, a value mismatch, and a reference to a non-key", () => {
    const rejected = [
      defineTable(
        (c) => ({ region: c.text(), number: c.integer() }),
        // @ts-expect-error -- two columns can't point at one.
        (t) => ({
          foreignKeys: [{ columns: [t.region, t.number], references: () => [users.columns.id] }],
        }),
      ),
      defineTable(
        (c) => ({ region: c.text() }),
        // @ts-expect-error -- one column can't point at two.
        (t) => ({
          foreignKeys: [
            {
              columns: [t.region],
              references: () => [shipments.columns.region, shipments.columns.number],
            },
          ],
        }),
      ),
      defineTable(
        (c) => ({ region: c.text(), number: c.integer() }),
        // @ts-expect-error -- an integer column can't point at a text one, nor a text at an integer.
        (t) => ({
          foreignKeys: [
            {
              columns: [t.number, t.region],
              references: () => [shipments.columns.region, shipments.columns.number],
            },
          ],
        }),
      ),
      defineTable(
        (c) => ({ id: c.integer().primaryKey(), label: c.text() }),
        // @ts-expect-error -- a text column can't point at an integer key.
        (t) => ({ foreignKeys: [{ columns: [t.label], references: [t.id] }] }),
      ),
      defineTable(
        (c) => ({ id: c.integer().primaryKey(), parent_id: c.integer(), other: c.integer() }),
        // @ts-expect-error -- other is neither a primary key nor unique.
        (t) => ({ foreignKeys: [{ columns: [t.parent_id], references: [t.other] }] }),
      ),
      defineTable(
        (c) => ({ x: c.text() }),
        // @ts-expect-error -- a column of a composite key is no key on its own.
        (t) => ({
          foreignKeys: [{ columns: [t.x], references: () => [shipments.columns.region] }],
        }),
      ),
    ];
    expect(rejected).toHaveLength(6);
  });

  it("accepts one column to a key, a composite pair, and a self reference with no annotation", () => {
    const accepted = defineTable(
      (c) => ({
        id: c.integer().primaryKey(),
        email: c.text().unique(),
        parent_id: c.integer(),
        parent_email: c.text(),
        other: c.text(),
        region: c.text(),
        number: c.integer(),
      }),
      (t) => ({
        foreignKeys: [
          { columns: [t.parent_id], references: [t.id] },
          { columns: [t.parent_email], references: [t.email] },
          { columns: [t.other], references: () => [users.columns.email] },
          {
            columns: [t.region, t.number],
            references: () => [shipments.columns.region, shipments.columns.number],
          },
        ],
      }),
    );
    expect(Object.keys(accepted.columns)).toHaveLength(7);
  });
});
