import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Queryable, Session } from "../../runtime/ports/index.ts";
import { namesOf, type Catalog } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

function dottedNames(catalog: Catalog): string[] {
  return [...catalog.values()].map((fact) => namesOf(catalog, fact).join("."));
}

beforeEach(async () => {
  await db.driver.execute(`
    drop extension if exists hstore cascade;
    drop schema if exists auth, ext cascade;
    drop schema public cascade;
    create schema public;
  `);
});

describe("introspect's read scope", () => {
  it("skips a foreign key to a table in a schema an extension owns", async () => {
    await db.driver.execute(`
      create extension hstore;
      create schema ext;
      alter extension hstore add schema ext;
      create table ext.loose (id integer primary key);
      create table public.refs (loose integer references ext.loose (id));
    `);

    expect(dottedNames(await introspect(db.driver))).toStrictEqual([
      "public",
      "public.refs",
      "public.refs.loose",
    ]);
  });

  it("keeps same-named tables in two schemas apart", async () => {
    await db.driver.execute(`
      create schema auth;
      create table public.t (a text);
      create table auth.t (b text);
    `);

    expect(dottedNames(await introspect(db.driver))).toStrictEqual([
      "auth",
      "auth.t",
      "auth.t.b",
      "public",
      "public.t",
      "public.t.a",
    ]);
  });

  it("reads inside one repeatable-read, read-only transaction", async () => {
    const seen: unknown[] = [];
    await db.driver.session(async (session) => {
      await introspect({
        ...session,
        transaction: (fn) =>
          session.transaction(async (tx) => {
            const result = await fn(tx);
            const { rows } = await tx.query(
              "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
            );
            seen.push(...rows);
            return result;
          }),
      });
    });

    expect(seen).toStrictEqual([{ isolation: "repeatable read", read_only: "on" }]);
  });

  it("refuses a server that reports no version, naming the unreadable one", async () => {
    const tx: Queryable = {
      execute: () => Promise.resolve(),
      query: () => Promise.resolve({ rows: [], count: 0 }),
    };
    const session: Session = { ...tx, transaction: (fn) => fn(tx) };

    await expect(introspect(session)).rejects.toThrow(
      "smonn/db needs Postgres 18 or newer, and this server runs Postgres NaN",
    );
  });
});
