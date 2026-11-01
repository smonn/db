import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineDomain, defineEnum, defineTable } from "../definition/index.ts";
import type { Codec, Row } from "../definition/index.ts";
import { createClient, from, sql, type Query, type Refs } from "./index.ts";

const upper: Codec<string, string> = {
  decode: (base) => base.toLowerCase(),
  encode: (value) => value.toUpperCase(),
};
const mood = defineEnum(["sad", "ok"]);

const db = defineDatabase(
  {
    public: {
      users: defineTable((c) => ({
        id: c.integer().identity().primaryKey(),
        email: c.text().notNull(),
        handle: c.text().codec(upper),
        mood: c.enum(mood),
        token: c.uuid(),
      })),
      posts: defineTable((c) => ({
        id: c.integer().identity().primaryKey(),
        authorId: c.bigint().notNull(),
        title: c.text().notNull(),
        mood: c.enum(defineEnum(["sad", "ok"])),
        moods: c.enum(mood).array(),
      })),
      users_2: defineTable((c) => ({ id: c.integer().notNull() })),
    },
  },
  { casing: "snake_case" },
);
const { users, posts } = db.public;

describe("innerJoin", () => {
  it("gives on, where, select, and orderBy one parameter per table, and qualifies every column", () => {
    const query = from(users)
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .where((_u, p) => p.title.eq("Hi"))
      .orderBy((u) => u.email)
      .select((u, p) => ({ email: u.email, authorId: p.authorId }));
    expect(query.toSql()).toStrictEqual({
      text: 'select "users"."email", "posts"."author_id" as "authorId" from "public"."users" inner join "public"."posts" on "posts"."author_id" = "users"."id" where "posts"."title" = $1 order by "users"."email"',
      params: ["Hi"],
    });
    expectTypeOf(query).toExtend<Query<{ email: string; authorId: bigint }>>();
    expectTypeOf(query).not.toExtend<Query<{ email: string; authorId: number }>>();
  });

  it("aliases a table joined to itself as name_2, then name_3, needing no alias argument", () => {
    const query = from(users)
      .innerJoin(users, (a, b) => b.id.eq(a.id))
      .innerJoin(users, (_a, b, c) => c.id.gt(b.id))
      .select((a, b, c) => ({ a: a.id, b: b.id, c: c.id }));
    expect(query.toSql().text).toBe(
      'select "users"."id" as "a", "users_2"."id" as "b", "users_3"."id" as "c" from "public"."users" inner join "public"."users" as "users_2" on "users_2"."id" = "users"."id" inner join "public"."users" as "users_3" on "users_3"."id" > "users_2"."id"',
    );
  });

  it("skips an alias another table's name holds", () => {
    const query = from(db.public.users_2)
      .innerJoin(users, (o, u) => u.id.eq(o.id))
      .innerJoin(users, (o, _u, again) => again.id.eq(o.id))
      .select((_o, u, again) => ({ u: u.id, again: again.id }));
    expect(query.toSql().text).toBe(
      'select "users"."id" as "u", "users_3"."id" as "again" from "public"."users_2" inner join "public"."users" on "users"."id" = "users_2"."id" inner join "public"."users" as "users_3" on "users_3"."id" = "users_2"."id"',
    );
  });

  it("qualifies a where, an orderBy, and an sql.expr ref written before the join", () => {
    const base = from(users)
      .where((u) => sql.expr<boolean>`${u.email} <> ''`)
      .orderBy((u) => u.id.desc());
    expect(base.toSql().text).toBe(
      `select "id", "email", "handle", "mood", "token" from "public"."users" where "email" <> '' order by "id" desc`,
    );
    const joined = base
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .select((_u, p) => ({ title: p.title }));
    expect(joined.toSql().text).toBe(
      `select "posts"."title" from "public"."users" inner join "public"."posts" on "posts"."author_id" = "users"."id" where "users"."email" <> '' order by "users"."id" desc`,
    );
  });

  it("takes where, orderBy, limit, and offset after select too", () => {
    const query = from(users)
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .select((_u, p) => ({ title: p.title, n: sql.expr<number>`1` }))
      .where((u) => u.id.gt(1))
      .orderBy((_u, p) => [p.id.asc(), sql.expr`2`])
      .limit(5)
      .offset(10);
    expect(query.toSql()).toStrictEqual({
      text: 'select "posts"."title", 1 as "n" from "public"."users" inner join "public"."posts" on "posts"."author_id" = "users"."id" where "users"."id" > $1 order by "posts"."id" asc, 2 limit $2 offset $3',
      params: [1, 5, 10],
    });
  });

  it("binds a value through the codec, and compares a column operand with none", () => {
    const query = from(users)
      .innerJoin(users, (a, b) => b.handle.eq(a.handle))
      .where((a) => a.handle.eq("ann"))
      .select((a) => ({ handle: a.handle }));
    expect(query.toSql()).toStrictEqual({
      text: 'select "users"."handle" from "public"."users" inner join "public"."users" as "users_2" on "users_2"."handle" = "users"."handle" where "users"."handle" = $1',
      params: ["ANN"],
    });
  });

  it("casts an enum array to text under its qualified name", () => {
    const query = from(users)
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .select((_u, p) => ({ moods: p.moods }));
    expect(query.toSql().text).toContain('select "posts"."moods"::text as "moods" from');
  });
});

describe("leftJoin", () => {
  it("renders a left join and types the joined table's columns nullable after on", () => {
    const query = from(users)
      .leftJoin(posts, (u, p) => p.authorId.eq(u.id))
      .where((_u, p) => p.title.isNull())
      .select((u, p) => ({ email: u.email, title: p.title }));
    expect(query.toSql().text).toBe(
      'select "users"."email", "posts"."title" from "public"."users" left join "public"."posts" on "posts"."author_id" = "users"."id" where "posts"."title" is null',
    );
    expectTypeOf(query).toExtend<Query<{ email: string; title: string | null }>>();
    expectTypeOf(query).not.toExtend<Query<{ email: string; title: string }>>();
  });

  it("shows on its table as declared, and later callbacks each column nullable", () => {
    void from(users)
      .leftJoin(posts, (u, p) => {
        expectTypeOf(p.title).not.toHaveProperty("isNull");
        return p.authorId.eq(u.id);
      })
      .orderBy((_u, p) => {
        expectTypeOf(p.title).toHaveProperty("isNull");
        return p.title.asc({ nulls: "first" });
      });
  });
});

describe("a joined builder", () => {
  const joined = from(users).innerJoin(posts, (u, p) => p.authorId.eq(u.id));

  it("is no Query before select, so a JavaScript caller's run throws, naming select", async () => {
    const client = createClient({
      query: () => Promise.reject(new Error("unreachable")),
      execute: () => Promise.reject(new Error("unreachable")),
    });
    // @ts-expect-error -- a joined builder needs select first.
    await expect(client.all(joined)).rejects.toThrow(
      "A query with a join needs select() to name its columns before it runs",
    );
    // @ts-expect-error -- a joined builder needs select first.
    await expect(client.run(joined)).rejects.toThrow("needs select()");
    expect(() => sql.expr`${joined}`).toThrow("value 1 is an unfinished statement");
  });

  it("has no pick, and select drops the joins", () => {
    expect("pick" in joined).toBe(false);
    const query = joined.select((u) => ({ id: u.id }));
    expect("innerJoin" in query).toBe(false);
    expect("leftJoin" in query).toBe(false);
    expect("pick" in query).toBe(false);
    expect("innerJoin" in from(users).select((u) => ({ id: u.id }))).toBe(false);
    expect("innerJoin" in from(users).pick("id")).toBe(false);
  });

  it("refuses an on callback that returns no predicate, for a caller the types don't stop", () => {
    // @ts-expect-error -- on returns a boolean, not a predicate.
    expect(() => from(users).innerJoin(posts, () => true)).toThrow(
      "innerJoin's on callback must return a predicate",
    );
    // @ts-expect-error -- on returns null, not a predicate.
    expect(() => joined.leftJoin(posts, () => null)).toThrow(
      "leftJoin's on callback must return a predicate",
    );
  });

  it("refuses a table defineDatabase never named", () => {
    const bare: unknown = defineTable((c) => ({ id: c.integer().notNull() }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain-JS callers reach this; TypeScript rejects it.
    const table = bare as typeof posts;
    expect(() => from(users).innerJoin(table, (u, p) => p.id.eq(u.id))).toThrow(/lacks SQL names/u);
  });

  it("refuses a select value or orderBy term that only looks like a column", () => {
    const lookalike = { name: "id" };
    expect(() => joined.select(() => ({ id: lookalike }))).toThrow(
      'select: "id" is no column or Expr',
    );
    expect(() => joined.orderBy(() => [sql.expr`1`, lookalike])).toThrow(
      "orderBy: term 2 is no column, Expr, or ordering",
    );
  });
});

describe("column operands", () => {
  it("leave a comparison's value side the column's own type, never null", () => {
    type UserRefs = Refs<Row<typeof users>>;
    expectTypeOf<string>().toExtend<Parameters<UserRefs["email"]["eq"]>[0]>();
    expectTypeOf<null>().not.toExtend<Parameters<UserRefs["handle"]["eq"]>[0]>();
    expectTypeOf<number>().not.toExtend<Parameters<UserRefs["email"]["eq"]>[0]>();
  });

  it("take a column of the same SQL type class, nullable or not, whatever its TypeScript type", () => {
    const query = from(users)
      .leftJoin(posts, (u, p) => p.authorId.eq(u.id))
      .where((u, p) => u.id.lte(p.authorId))
      .select((u) => ({ id: u.id }));
    expect(query.toSql().text).toContain('where "users"."id" <= "posts"."author_id"');
    void from(users).innerJoin(posts, (u, p) => {
      // @ts-expect-error -- uuid and text are different classes, which Postgres can't compare.
      void u.token.eq(p.title);
      // @ts-expect-error -- a column operand doesn't make null a value.
      void u.email.eq(null);
      return u.email.ne(p.title);
    });
  });

  it("refuses two different enums, naming both columns", () => {
    expect(() => from(users).innerJoin(posts, (u, p) => p.mood.eq(u.mood))).toThrow(
      "Can't compare posts.mood with users.mood: Postgres compares an enum, a domain over one, or an array only with the identical type",
    );
    expect(() => from(users).innerJoin(users, (a, b) => b.mood.eq(a.mood))).not.toThrow();
  });

  it("names a self-joined column by its alias and SQL name", () => {
    const dbs = defineDatabase({
      public: {
        notes: defineTable((c) => ({
          mood: c.enum(mood),
          plain: c.domain(defineDomain((d) => d.enum(mood))),
        })),
      },
    });
    const notes = dbs.public.notes;
    expect(() => from(notes).innerJoin(notes, (a, b) => b.plain.eq(a.mood))).toThrow(
      "Can't compare notes_2.plain with notes.mood",
    );
  });
});
