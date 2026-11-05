/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Run from a copy of the repo's adapter beside a postgres install: node <this file> (copied into pg3/ or pg4/).
import { attempt } from "./attempt.mjs";
import postgres from "postgres";
import { postgresJsDriver } from "./repo-src/adapters/postgres-js/driver.ts";
import {
  postgresJsConnection,
  postgresJsTypes,
} from "./repo-src/adapters/postgres-js/value-types.ts";

const max = Number(process.argv[2] ?? 1);
const sql = postgres(process.env.DATABASE_URL, {
  max,
  onnotice: () => {},
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const driver = postgresJsDriver(sql);
const version = process.argv[3] ?? "?";
console.log("postgres", version, "max", max, "(repo driver)");
await driver.execute?.("drop schema if exists d623 cascade; create schema d623;");

console.log("retype column");
await driver.execute(
  "create table d623.t (id int primary key, v integer); insert into d623.t values (1, 1)",
);
await attempt("before", () => driver.query("select v from d623.t where v = $1", [1]));
await driver.execute("alter table d623.t alter column v type text using v::text");
await attempt("after retype", () => driver.query("select v from d623.t where v = $1", ["abc"]));
await attempt("after retype (2)", () => driver.query("select v from d623.t where v = $1", ["abc"]));

console.log("recreate enum");
await driver.execute(
  "create type d623.m as enum ('a','b'); create table d623.e (id int primary key, m d623.m); insert into d623.e values (1,'a')",
);
await attempt("before", () => driver.query("select m from d623.e where m = $1", ["a"]));
await driver.execute(
  "alter table d623.e alter column m type text; drop type d623.m; create type d623.m as enum ('a','b'); alter table d623.e alter column m type d623.m using m::d623.m",
);
await attempt("after enum recreate", () =>
  driver.query("select m from d623.e where m = $1", ["a"]),
);
await attempt("after enum recreate (2)", () =>
  driver.query("select m from d623.e where m = $1", ["a"]),
);

console.log("recreate domain, select");
await driver.execute(
  "create domain d623.d as integer; create table d623.dd (id int primary key, v d623.d); insert into d623.dd values (1, 1)",
);
await attempt("before", () => driver.query("select v from d623.dd where id = $1", [1]));
await driver.execute(
  "drop table d623.dd; drop domain d623.d; create domain d623.d as integer; create table d623.dd (id int primary key, v d623.d); insert into d623.dd values (1, 1)",
);
await attempt("after domain recreate", () =>
  driver.query("select v from d623.dd where id = $1", [1]),
);
await attempt("after domain recreate (2)", () =>
  driver.query("select v from d623.dd where id = $1", [1]),
);

console.log("same, through driver.session (reset runs `discard plans` etc. on release)");
await driver.session(async (s) => {
  await s.execute(
    "drop table d623.dd; drop domain d623.d; create domain d623.d as integer; create table d623.dd (id int primary key, v d623.d); insert into d623.dd values (1, 1)",
  );
  await attempt("in session after domain recreate", () =>
    s.query("select v from d623.dd where id = $1", [1]),
  );
});
await attempt("on pool after session", () =>
  driver.query("select v from d623.dd where id = $1", [1]),
);

await driver.execute("drop schema d623 cascade");
await sql.end();
