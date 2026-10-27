import { describe, expect, it } from "vitest";
import { FK } from "./foreign-keys.test-helper.ts";
import {
  add,
  drop,
  indexNamed,
  invoices,
  statements,
  world,
  type World,
} from "./rebuilt-foreign-keys.test-helper.ts";

describe("a foreign key that a retype blocks", () => {
  it("drops the old name and adds the new one in place of a rename", () => {
    const sql = statements(
      world({ foreignKeys: { old_fkey: {} } }),
      world({ foreignKeys: { new_fkey: {} }, userId: "text" }),
    );

    expect(sql).toStrictEqual([
      drop("old_fkey"),
      `alter table "public"."orders" alter column "user_id" type text;`,
      expect.stringContaining(add("new_fkey")),
    ]);
  });

  it("drops and adds one that changes itself once", () => {
    const sql = statements(
      world(),
      world({ foreignKeys: { [FK]: { onDelete: "cascade" } }, userId: "text" }),
    );

    expect(sql).toStrictEqual([
      drop(FK),
      `alter table "public"."orders" alter column "user_id" type text;`,
      expect.stringContaining(add(FK)),
    ]);
  });

  it("drops the old key and adds the new one when a name switches from a unique key", () => {
    const from = world({
      foreignKeys: {},
      onOrders: (builder) => {
        builder.unique("public", "orders", FK, { columns: ["user_id"], nullsNotDistinct: false });
      },
    });

    expect(statements(from, world())).toStrictEqual([drop(FK), expect.stringContaining(add(FK))]);
  });
});

describe("a foreign key that stays as it is while a retype blocks it", () => {
  const decoys: [string, Partial<World>, Partial<World>][] = [
    ["an index of the same name that drops", { onOrders: indexNamed(FK) }, {}],
    [
      "a foreign key of the same name on another table that drops",
      { beforeOrders: invoices(FK) },
      { beforeOrders: invoices() },
    ],
    [
      "another foreign key on the same table that drops",
      { foreignKeys: { other_fkey: { columns: ["note"] }, [FK]: {} } },
      { foreignKeys: { [FK]: {} } },
    ],
  ];

  it.each(decoys)("drops it and adds it back, beside %s", (_, before, after) => {
    const sql = statements(world(before), world({ ...after, userId: "text" }));

    expect(sql).toContain(drop(FK));
    expect(sql.some((statement) => statement.startsWith(add(FK)))).toBe(true);
  });

  it("leaves it alone when only a column it doesn't use is retyped", () => {
    expect(statements(world(), world({ note: "integer" }))).toStrictEqual([
      `alter table "public"."orders" alter column "note" type integer;`,
    ]);
  });
});
