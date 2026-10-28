import { describe, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { Client } from "./client.ts";
import { insert } from "./insert.ts";

declare const client: Client;

const db = defineDatabase({
  public: {
    tags: defineTable((c) => ({ tag: c.text().primaryKey(), deletedAt: c.timestamptz() })),
  },
});

const one = insert(db.public.tags).values({ tag: "x" });
const many = insert(db.public.tags).values([{ tag: "x" }, { tag: "y" }]);

describe("conflict markers", () => {
  it("keeps client.one off a result that may be missing or several rows", () => {
    const nothing = one
      .onConflict((t) => [t.tag])
      .doNothing()
      .returning((t) => ({ tag: t.tag }));
    const guarded = one
      .onConflict((t) => [t.tag])
      .doUpdate((excluded) => ({ tag: excluded.tag }))
      .where((existing) => existing.deletedAt.isNull())
      .returning((t) => ({ tag: t.tag }));
    const always = one
      .onConflict((t) => [t.tag])
      .doUpdate((excluded) => ({ tag: excluded.tag }))
      .returning((t) => ({ tag: t.tag }));
    const several = many
      .onConflict((t) => [t.tag])
      .doUpdate((excluded) => ({ tag: excluded.tag }))
      .returning((t) => ({ tag: t.tag }));
    // Never called: these only have to type-check, or fail to.
    const calls = () => {
      // @ts-expect-error -- do nothing may skip the row
      void client.one(nothing);
      void client.all(nothing);
      // @ts-expect-error -- the where may skip the update
      void client.one(guarded);
      void client.all(guarded);
      void client.one(always);
      // @ts-expect-error -- several rows
      void client.one(several);
    };
    expectTypeOf(calls).toBeFunction();
    expectTypeOf(several).toHaveProperty("~many");
  });

  it("drops onConflict and doUpdate once an action ran", () => {
    const done = one.onConflict((t) => [t.tag]).doNothing();
    expectTypeOf(done).not.toHaveProperty("onConflict");
    expectTypeOf(done).not.toHaveProperty("where");
    const updated = one.onConflict((t) => [t.tag]).doUpdate(() => ({ tag: "y" }));
    expectTypeOf(updated).not.toHaveProperty("onConflict");
    expectTypeOf(updated).not.toHaveProperty("doUpdate");
    const filtered = updated.where((existing) => existing.deletedAt.isNull());
    expectTypeOf(filtered).not.toHaveProperty("doUpdate");
    expectTypeOf(filtered).toHaveProperty("where");
  });
});
