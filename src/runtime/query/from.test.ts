import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { and, from, not, or, type Predicate, type Query, type Refs } from "./from.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
  },
});

describe("from", () => {
  it("selects every column of the table without select", () => {
    expect(from(db.public.users).toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users"',
      params: [],
    });
  });

  it("types the rows as the table's Row without select", () => {
    expectTypeOf(from(db.public.users)).toExtend<Query<{ id: string; email: string | null }>>();
  });
});

describe("select", () => {
  it("names each output column by its key", () => {
    const query = from(db.public.users).select((u) => ({ id: u.id, mail: u.email }));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" as "mail" from "public"."users"',
      params: [],
    });
  });

  it("types each output column by its key, keeping nullability", () => {
    const query = from(db.public.users).select((u) => ({ mail: u.email, key: u.id }));
    expectTypeOf(query).toExtend<Query<{ mail: string | null; key: string }>>();
    expectTypeOf(query).not.toExtend<Query<{ mail: string; key: string }>>();
  });

  it("replaces the previous select", () => {
    const query = from(db.public.users)
      .select((u) => ({ id: u.id }))
      .select((u) => ({ email: u.email }));
    expect(query.toSql().text).toBe('select "email" from "public"."users"');
  });

  it("quotes names that need it", () => {
    const odd = defineDatabase({
      'my"schema': { "Odd Table": defineTable((c) => ({ "a b": c.text() })) },
    });
    expect(from(odd['my"schema']["Odd Table"]).toSql().text).toBe(
      'select "a b" from "my""schema"."Odd Table"',
    );
  });

  it("hands select only the table's columns", () => {
    expectTypeOf<keyof Refs<typeof db.public.users>>().toEqualTypeOf<"id" | "email">();
  });
});

describe("where", () => {
  const users = from(db.public.users);

  it("renders each comparison with its value as a param", () => {
    const cases = [
      [users.where((u) => u.id.eq("a")), '"id" = $1', ["a"]],
      [users.where((u) => u.id.ne("a")), '"id" <> $1', ["a"]],
      [users.where((u) => u.id.gt("a")), '"id" > $1', ["a"]],
      [users.where((u) => u.id.gte("a")), '"id" >= $1', ["a"]],
      [users.where((u) => u.id.lt("a")), '"id" < $1', ["a"]],
      [users.where((u) => u.id.lte("a")), '"id" <= $1', ["a"]],
      [users.where((u) => u.email.isNull()), '"email" is null', []],
      [users.where((u) => u.email.isNotNull()), '"email" is not null', []],
    ] as const;
    for (const [query, predicate, params] of cases) {
      expect(query.toSql()).toStrictEqual({
        text: `select "id", "email" from "public"."users" where ${predicate}`,
        params,
      });
    }
  });

  it("joins terms with and, parenthesised", () => {
    const query = users.where((u) => and(u.id.gt("a"), u.id.lt("z"), u.email.isNull()));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users" where ("id" > $1 and "id" < $2 and "email" is null)',
      params: ["a", "z"],
    });
  });

  it("joins terms with or, parenthesised", () => {
    const query = users.where((u) => or(u.id.eq("a"), u.id.eq("b")));
    expect(query.toSql().text).toBe(
      'select "id", "email" from "public"."users" where ("id" = $1 or "id" = $2)',
    );
  });

  it("negates with not", () => {
    const query = users.where((u) => not(u.id.eq("a")));
    expect(query.toSql().text).toBe(
      'select "id", "email" from "public"."users" where not ("id" = $1)',
    );
  });

  it("nests, numbering params in order", () => {
    const query = users.where((u) =>
      and(or(u.id.eq("a"), u.id.eq("b")), not(and(u.email.isNull(), u.id.ne("c")))),
    );
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users" where (("id" = $1 or "id" = $2) and not (("email" is null and "id" <> $3)))',
      params: ["a", "b", "c"],
    });
  });

  it("keeps the select, whichever call comes first", () => {
    const selectFirst = users.select((u) => ({ mail: u.email })).where((u) => u.id.eq("a"));
    const whereFirst = users.where((u) => u.id.eq("a")).select((u) => ({ mail: u.email }));
    const expected = {
      text: 'select "email" as "mail" from "public"."users" where "id" = $1',
      params: ["a"],
    };
    expect(selectFirst.toSql()).toStrictEqual(expected);
    expect(whereFirst.toSql()).toStrictEqual(expected);
  });

  it("combines a second where with the first using and", () => {
    const query = users.where((u) => u.id.gt("a")).where((u) => or(u.id.eq("b"), u.email.isNull()));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users" where ("id" > $1 and ("id" = $2 or "email" is null))',
      params: ["a", "b"],
    });
  });

  it("takes one or more predicates in and and or, and exactly one in not", () => {
    expectTypeOf(and).parameters.toEqualTypeOf<[first: Predicate, ...rest: Predicate[]]>();
    expectTypeOf(or).parameters.toEqualTypeOf<[first: Predicate, ...rest: Predicate[]]>();
    expectTypeOf(not).parameters.toEqualTypeOf<[term: Predicate]>();
  });

  it("offers isNull and isNotNull only on nullable columns", () => {
    /* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return -- The calls are the type errors under test. */
    const notNull = users.where((u) => {
      // @ts-expect-error -- id is NOT NULL.
      return u.id.isNull();
    });
    const notNotNull = users.where((u) => {
      // @ts-expect-error -- id is NOT NULL.
      return u.id.isNotNull();
    });
    /* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return */
    expect(notNull.toSql().text).toContain("is null");
    expect(notNotNull.toSql().text).toContain("is not null");
  });

  it("does not change the row type", () => {
    expectTypeOf(users.where((u) => u.id.eq("a"))).toExtend<
      Query<{ id: string; email: string | null }>
    >();
  });

  it("compares a column only with its own value type, never null", () => {
    type UserRefs = Refs<typeof db.public.users>;
    expectTypeOf<Parameters<UserRefs["id"]["eq"]>>().toEqualTypeOf<[value: string]>();
    expectTypeOf<Parameters<UserRefs["email"]["eq"]>>().toEqualTypeOf<[value: string]>();
  });
});
