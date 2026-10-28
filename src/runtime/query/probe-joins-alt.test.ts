import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { Query } from "./from.ts";
import { fromKind, fromNamed } from "./probe-joins-alt.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.uuid().primaryKey(),
      fullName: c.text().notNull(),
      managerId: c.uuid(),
    })),
    posts: defineTable((c) => ({
      id: c.integer().primaryKey(),
      authorId: c.uuid().notNull(),
      title: c.text().notNull(),
      score: c.integer(),
    })),
    comments: defineTable((c) => ({
      id: c.integer().primaryKey(),
      postId: c.integer().notNull(),
      body: c.text(),
    })),
  },
});
const { users, posts, comments } = db.public;

describe("alternative A: named refs", () => {
  it("names each table by the alias the caller gives", () => {
    const query = fromNamed({ u: users })
      .leftJoin({ m: users }, ({ u, m }) => u.managerId.eq(m.id))
      .innerJoin({ p: posts }, ({ u, p }) => p.authorId.eq(u.id))
      .where(({ p }) => p.score.gt(1))
      .select(({ u, m, p }) => ({ name: u.fullName, manager: m.fullName, title: p.title }));
    expectTypeOf(query).toExtend<Query<{ name: string; manager: string | null; title: string }>>();
    expect(query.toSql().text).toContain('"users_2"."fullName" as "manager"');
  });

  it("refuses an alias in use and an unknown one", () => {
    /* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access -- The calls are the type errors under test. */
    expect(() =>
      // @ts-expect-error -- u is in use.
      fromNamed({ u: users }).innerJoin({ u: posts }, ({ u }) => u.id.isNotNull()),
    ).toThrow("u is already in use");
    const unknown = fromNamed({ u: users }).innerJoin(
      { p: posts },
      // @ts-expect-error -- q names no table.
      ({ q, u }) => q.authorId.eq(u.id),
    );
    /* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access */
    expect(unknown).toHaveProperty("select");
  });
});

describe("alternative C: one join with a kind", () => {
  it("types the kind's nullability", () => {
    const query = fromKind(users)
      .join(posts, (u, p) => p.authorId.eq(u.id), "left")
      .join(comments, (_u, p, c) => c.postId.eq(p.id))
      .select((u, p, c) => ({ name: u.fullName, title: p.title, body: c.body }));
    expectTypeOf(query).toExtend<
      Query<{ name: string; title: string | null; body: string | null }>
    >();
    expect(query.toSql().text).toContain("left join");
  });

  it("refuses a kind outside inner and left", () => {
    // @ts-expect-error -- right is no kind.
    const right = fromKind(users).join(posts, (u, p) => p.authorId.eq(u.id), "right");
    expect(right).toHaveProperty("select");
  });
});
