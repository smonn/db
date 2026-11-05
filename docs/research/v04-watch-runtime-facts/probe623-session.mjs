/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// #623 on ONE reserved connection (what a watch holding the Dev lock would use for every run), through the repo's driver.
import { attempt } from "./attempt.mjs";
import postgres from "postgres";
import { postgresJsDriver } from "./repo-src/adapters/postgres-js/driver.ts";
import {
  postgresJsConnection,
  postgresJsTypes,
} from "./repo-src/adapters/postgres-js/value-types.ts";

const sql = postgres(process.env.DATABASE_URL, {
  max: 2,
  onnotice: () => {},
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const driver = postgresJsDriver(sql);
console.log(
  "postgres",
  process.argv[2],
  "one session across several 'runs', each a different DDL, no reset between",
);
await driver.session(async (s) => {
  await s.execute("drop schema if exists s623 cascade; create schema s623;");
  await s.execute(
    "create table s623.t (id int primary key, v integer); insert into s623.t values (1, 1)",
  );
  await s.execute(
    "create type s623.m as enum ('a','b'); create table s623.e (id int primary key, m s623.m); insert into s623.e values (1,'a')",
  );
  await attempt("run 1 select int column", () => s.query("select v from s623.t where v = $1", [1]));
  await attempt("run 1 select enum column", () =>
    s.query("select m from s623.e where m = $1", ["a"]),
  );
  await attempt("run 1 insert enum", () =>
    s.query("insert into s623.e (id, m) values ($1, $2) on conflict (id) do nothing", [2, "b"]),
  );
  await s.execute("alter table s623.t alter column v type text using v::text");
  await attempt("run 2 after retype", () => s.query("select v from s623.t where v = $1", ["abc"]));
  await s.execute(
    "alter table s623.e alter column m type text; drop type s623.m; create type s623.m as enum ('a','b','c'); alter table s623.e alter column m type s623.m using m::s623.m",
  );
  await attempt("run 3 select enum after recreate", () =>
    s.query("select m from s623.e where m = $1", ["a"]),
  );
  await attempt("run 3 insert enum after recreate", () =>
    s.query("insert into s623.e (id, m) values ($1, $2) on conflict (id) do nothing", [3, "c"]),
  );
  await s.transaction(async (t) => {
    await t.execute("alter table s623.t alter column v type integer using 0");
  });
  await attempt("run 4 select int column after retype back, inside session", () =>
    s.query("select v from s623.t where v = $1", [0]),
  );
  await attempt("run 4 inside a transaction on the session", () =>
    s.transaction((t) => t.query("select v from s623.t where v = $1", [0])),
  );
  await s.execute("drop schema s623 cascade");
});
await sql.end();
