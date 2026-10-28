import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable, type Codec } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { and, from as singleFrom, or, type Query } from "./from.ts";
import { aliasFor, from, type JoinRef } from "./probe-joins.ts";

type Day = { readonly iso: string };
const day: Codec<string, Day> = {
  decode: (base) => ({ iso: base }),
  encode: (value) => value.iso,
};

const db = defineDatabase(
  {
    appData: {
      users: defineTable((c) => ({
        id: c.uuid().primaryKey(),
        fullName: c.text().notNull(),
        managerId: c.uuid(),
        joinedOn: c.date().codec(day).notNull(),
      })),
      blogPosts: defineTable((c) => ({
        id: c.integer().primaryKey(),
        authorId: c.uuid().notNull(),
        title: c.text().notNull(),
        score: c.integer(),
        publishedOn: c.date().codec(day),
      })),
      comments: defineTable((c) => ({
        id: c.integer().primaryKey(),
        postId: c.integer().notNull(),
        body: c.text().name("Body"),
      })),
    },
  },
  { casing: "snake_case" },
);
const { users, blogPosts: posts, comments } = db.appData;

const ann = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const cid = "00000000-0000-4000-8000-000000000003";

describe("types", () => {
  it("adds one callback parameter per joined table, in on, where, orderBy, and select", () => {
    const query = from(users)
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .where((u, p) => and(u.fullName.eq("Ann"), p.score.gt(1)))
      .orderBy((_u, p) => p.title)
      .select((u, p) => ({ name: u.fullName, title: p.title, score: p.score }));
    expectTypeOf(query).toExtend<Query<{ name: string; title: string; score: number | null }>>();
  });

  it("types a left-joined table's columns nullable after on, with isNull", () => {
    from(users).leftJoin(posts, (u, p) => {
      expectTypeOf(p.id).toEqualTypeOf<JoinRef<number>>();
      expectTypeOf(p.id).not.toHaveProperty("isNull");
      return p.authorId.eq(u.id);
    });
    const query = from(users)
      .leftJoin(posts, (u, p) => p.authorId.eq(u.id))
      .where((_u, p) => p.id.isNull())
      .select((u, p) => ({ name: u.fullName, title: p.title }));
    expectTypeOf(query).toExtend<Query<{ name: string; title: string | null }>>();
    expectTypeOf(query).not.toExtend<Query<{ name: string; title: string }>>();
  });

  it("self-joins with no alias argument", () => {
    const query = from(users)
      .leftJoin(users, (u, m) => u.managerId.eq(m.id))
      .select((u, m) => ({ name: u.fullName, manager: m.fullName }));
    expectTypeOf(query).toExtend<Query<{ name: string; manager: string | null }>>();
  });

  it("compares with a value or a column of the same type, nullable or not", () => {
    const both = from(users)
      .innerJoin(posts, (u, p) =>
        and(p.authorId.eq(u.id), u.id.eq(p.authorId), u.managerId.eq(p.authorId), p.id.gt(3)),
      )
      .select((u) => ({ id: u.id }));
    expect(both.toSql().params).toStrictEqual([3]);
    // A left-joined column is an operand too.
    const left = from(users)
      .leftJoin(posts, (u, p) => p.authorId.eq(u.id))
      .innerJoin(comments, (_u, p, c) => c.postId.eq(p.id))
      .select((_u, _p, c) => ({ id: c.id }));
    expect(left.toSql().text).toContain('"comments"."post_id" = "blog_posts"."id"');
  });

  it("keeps the codec's value type per table", () => {
    const query = from(users)
      .leftJoin(posts, (u, p) => p.authorId.eq(u.id))
      .select((u, p) => ({ joined: u.joinedOn, published: p.publishedOn }));
    expectTypeOf(query).toExtend<Query<{ joined: Day; published: Day | null }>>();
  });

  it("refuses misuse at compile time", () => {
    /* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access -- The calls are the type errors under test. */
    // @ts-expect-error -- on is required.
    expect(() => from(users).innerJoin(posts)).toThrow("innerJoin needs an on callback");

    // @ts-expect-error -- uuid against integer.
    from(users).innerJoin(posts, (u, p) => u.id.eq(p.score));

    // @ts-expect-error -- null is no operand.
    from(users).innerJoin(posts, (u, p) => and(p.authorId.eq(u.id), p.score.eq(null)));

    // @ts-expect-error -- on sees the joined table's NOT NULL columns as declared.
    from(users).leftJoin(posts, (_u, p) => p.id.isNull());

    // @ts-expect-error -- a third parameter names no table.
    from(users).innerJoin(posts, (u, p, x) => x.id.eq(u.id));

    const joined = from(users).innerJoin(posts, (u, p) => p.authorId.eq(u.id));
    // @ts-expect-error -- a joined builder needs select.
    expect(() => joined.toSql()).toThrow("needs select");
    // @ts-expect-error -- pick is hidden after a join.
    expect(() => joined.pick("id")).toThrow(TypeError);

    const selected = joined.select((u) => ({ id: u.id }));
    // @ts-expect-error -- joins come before select.
    expect(() => selected.innerJoin(comments, (_u, p, c) => c.postId.eq(p.id))).toThrow(TypeError);
    const single = from(users).select((u) => ({ id: u.id }));
    // @ts-expect-error -- joins come before select, on one table too.
    expect(() => single.leftJoin(posts, (u, p) => p.authorId.eq(u.id))).toThrow(TypeError);
    /* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access */
  });

  it("refuses a joined builder in client.all", () => {
    const client = createClient({
      query: () => Promise.resolve({ rows: [], count: 0 }),
      execute: () => Promise.resolve(),
    });
    const joined = from(users).innerJoin(posts, (u, p) => p.authorId.eq(u.id));
    // @ts-expect-error -- not a Query until select.
    return expect(client.all(joined)).rejects.toThrow(
      "A query with a join needs select to name its columns",
    );
  });
});

describe("SQL", () => {
  it("leaves single-table SQL unchanged", () => {
    const probe = from(users).where((u) => or(u.id.eq(ann), u.managerId.isNull()));
    const today = singleFrom(users).where((u) => or(u.id.eq(ann), u.managerId.isNull()));
    expect(probe.toSql()).toStrictEqual(today.toSql());
    expect(
      from(users)
        .select((u) => ({ n: u.fullName }))
        .toSql(),
    ).toStrictEqual(
      singleFrom(users)
        .select((u) => ({ n: u.fullName }))
        .toSql(),
    );
  });

  it("qualifies every column by its table's SQL name", () => {
    const query = from(users)
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .where((_u, p) => p.score.gt(1))
      .select((u, p) => ({ authorId: p.authorId, name: u.fullName, id: p.id }));
    expect(query.toSql()).toStrictEqual({
      text: 'select "blog_posts"."author_id" as "authorId", "users"."full_name" as "name", "blog_posts"."id" from "app_data"."users" inner join "app_data"."blog_posts" on "blog_posts"."author_id" = "users"."id" where "blog_posts"."score" > $1',
      params: [1],
    });
  });

  it("aliases a repeated table with _2, _3", () => {
    const query = from(users)
      .leftJoin(users, (u, m) => u.managerId.eq(m.id))
      .leftJoin(users, (_u, m, g) => m.managerId.eq(g.id))
      .select((u, m, g) => ({ name: u.fullName, manager: m.fullName, grand: g.fullName }));
    expect(query.toSql().text).toBe(
      'select "users"."full_name" as "name", "users_2"."full_name" as "manager", "users_3"."full_name" as "grand" from "app_data"."users" left join "app_data"."users" as "users_2" on "users"."manager_id" = "users_2"."id" left join "app_data"."users" as "users_3" on "users_2"."manager_id" = "users_3"."id"',
    );
  });

  it("skips an alias another table already holds", () => {
    expect(aliasFor("users", new Set(["users", "users_2"]))).toBe("users_3");
  });

  it("qualifies a where given before the join", () => {
    const query = from(users)
      .where((u) => u.id.eq(ann))
      .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
      .select((_u, p) => ({ title: p.title }));
    expect(query.toSql().text).toContain('where "users"."id" = $1');
  });

  it("encodes a value by the column's own codec, and a column operand not at all", () => {
    const query = from(users)
      .innerJoin(posts, (u, p) =>
        and(p.publishedOn.gte({ iso: "2024-01-01" }), p.publishedOn.gte(u.joinedOn)),
      )
      .select((u) => ({ id: u.id }));
    const { text, params } = query.toSql();
    expect(text).toContain(
      'on ("blog_posts"."published_on" >= $1 and "blog_posts"."published_on" >= "users"."joined_on")',
    );
    expect(params).toStrictEqual(["2024-01-01"]);
  });
});

describe("on Postgres", () => {
  const testDatabase = useTestDatabase();
  const client = createClient(testDatabase.driver);

  beforeEach(async () => {
    await testDatabase.driver.execute(`
      drop schema if exists app_data cascade;
      create schema app_data;
      create table app_data.users (id uuid primary key, full_name text not null, manager_id uuid, joined_on date not null);
      create table app_data.blog_posts (id integer primary key, author_id uuid not null, title text not null, score integer, published_on date);
      create table app_data.comments (id integer primary key, post_id integer not null, "Body" text);
      insert into app_data.users values ('${ann}', 'Ann', null, '2020-01-01'), ('${bob}', 'Bob', '${ann}', '2021-01-01'), ('${cid}', 'Cid', '${bob}', '2022-01-01');
      insert into app_data.blog_posts values (1, '${ann}', 'Hello', 5, '2024-02-01'), (2, '${bob}', 'Draft', null, null);
      insert into app_data.comments values (10, 1, 'Nice'), (11, 1, null);
    `);
  });

  it("runs a self-join, decoding per table and leaving a NULL undecoded", async () => {
    const rows = await client.all(
      from(users)
        .leftJoin(users, (u, m) => u.managerId.eq(m.id))
        .leftJoin(users, (_u, m, g) => m.managerId.eq(g.id))
        .orderBy((u) => u.fullName)
        .select((u, m, g) => ({
          name: u.fullName,
          joined: u.joinedOn,
          manager: m.fullName,
          managerJoined: m.joinedOn,
          grand: g.fullName,
        })),
    );
    expect(rows).toStrictEqual([
      {
        name: "Ann",
        joined: { iso: "2020-01-01" },
        manager: null,
        managerJoined: null,
        grand: null,
      },
      {
        name: "Bob",
        joined: { iso: "2021-01-01" },
        manager: "Ann",
        managerJoined: { iso: "2020-01-01" },
        grand: null,
      },
      {
        name: "Cid",
        joined: { iso: "2022-01-01" },
        manager: "Bob",
        managerJoined: { iso: "2021-01-01" },
        grand: "Ann",
      },
    ]);
  });

  it("runs a three-table join under casing and .name()", async () => {
    const rows = await client.all(
      from(users)
        .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
        .leftJoin(comments, (_u, p, c) => c.postId.eq(p.id))
        .where((_u, p) => p.publishedOn.gte({ iso: "2024-01-01" }))
        .orderBy((_u, _p, c) => c.id)
        .select((u, p, c) => ({ name: u.fullName, published: p.publishedOn, body: c.body })),
    );
    expect(rows).toStrictEqual([
      { name: "Ann", published: { iso: "2024-02-01" }, body: "Nice" },
      { name: "Ann", published: { iso: "2024-02-01" }, body: null },
    ]);
  });

  it("returns a missing left side as nulls", async () => {
    const rows = await client.all(
      from(posts)
        .leftJoin(comments, (p, c) => c.postId.eq(p.id))
        .where((p) => p.id.eq(2))
        .select((p, c) => ({ title: p.title, published: p.publishedOn, comment: c.id })),
    );
    expect(rows).toStrictEqual([{ title: "Draft", published: null, comment: null }]);
  });
});
