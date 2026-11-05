/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node probe623.mjs <path to postgres entry> [max]
// Reproduces #623 through unsafe(text, params, {prepare:true, simple:false}), as the repo's driver sends it.
import { pathToFileURL } from "node:url";
const entry = process.argv[2];
const max = Number(process.argv[3] ?? 1);
const mod = await import(pathToFileURL(entry).href);
const postgres = mod.default;
const url = process.env.DATABASE_URL;
const sql = postgres(url, { max, onnotice: () => {} });
console.log("postgres entry:", entry, "max:", max);

const prep = { prepare: true, simple: false };
const q = (text, params = []) => sql.unsafe(text, params, prep);
const exec = (script) => sql.unsafe(script).simple();

async function attempt(label, fn) {
  try {
    const r = await fn();
    console.log(`  ${label}: OK`, JSON.stringify(r));
  } catch (e) {
    console.log(`  ${label}: FAIL ${e.code ?? ""} ${e.message}`);
  }
}

await exec("drop schema if exists p623 cascade; create schema p623;");

console.log("case 1: retype integer -> text, same SQL text");
await exec("create table p623.t (id int primary key, v integer); insert into p623.t values (1, 1)");
await attempt("before DDL", () => q("select v from p623.t where v = $1", [1]));
await attempt("before DDL (insert)", () =>
  q("insert into p623.t (id, v) values ($1, $2) on conflict (id) do nothing", [2, 2]),
);
await exec("alter table p623.t alter column v type text using v::text");
await attempt("after DDL, text param 'abc' (select)", () =>
  q("select v from p623.t where v = $1", ["abc"]),
);
await attempt("after DDL, same select again", () =>
  q("select v from p623.t where v = $1", ["abc"]),
);
await attempt("after DDL (insert text 'x')", () =>
  q("insert into p623.t (id, v) values ($1, $2) on conflict (id) do nothing", [3, "x"]),
);

console.log("case 2: recreate enum, same SQL text");
await exec(
  "create type p623.mood as enum ('a','b'); create table p623.e (id int primary key, m p623.mood); insert into p623.e values (1,'a')",
);
await attempt("before DDL", () => q("select m from p623.e where m = $1", ["a"]));
await attempt("before DDL insert", () =>
  q("insert into p623.e (id, m) values ($1, $2) on conflict (id) do nothing", [2, "b"]),
);
await exec(
  "alter table p623.e alter column m type text; drop type p623.mood; create type p623.mood as enum ('a','b'); alter table p623.e alter column m type p623.mood using m::p623.mood",
);
await attempt("after enum recreate select", () => q("select m from p623.e where m = $1", ["a"]));
await attempt("after enum recreate select (2nd)", () =>
  q("select m from p623.e where m = $1", ["a"]),
);
await attempt("after enum recreate insert", () =>
  q("insert into p623.e (id, m) values ($1, $2) on conflict (id) do nothing", [3, "b"]),
);
await attempt("after enum recreate insert (2nd)", () =>
  q("insert into p623.e (id, m) values ($1, $2) on conflict (id) do nothing", [4, "b"]),
);

console.log("case 3: recreate domain, same SQL text");
await exec(
  "create domain p623.d as integer; create table p623.dd (id int primary key, v p623.d); insert into p623.dd values (1, 1)",
);
await attempt("before DDL", () => q("select v from p623.dd where v = $1", [1]));
await exec(
  "alter table p623.dd alter column v type integer; drop domain p623.d; create domain p623.d as integer check (value > 0); alter table p623.dd alter column v type p623.d",
);
await attempt("after domain recreate select", () => q("select v from p623.dd where v = $1", [1]));
await attempt("after domain recreate select (2nd)", () =>
  q("select v from p623.dd where v = $1", [1]),
);

console.log("case 4: enum recreated while column kept as enum (drop cascade, recreate table)");
await exec(
  "create type p623.c as enum ('x','y'); create table p623.ce (id int primary key, c p623.c)",
);
await attempt("before", () => q("select id from p623.ce where c = $1", ["x"]));
await exec(
  "drop table p623.ce; drop type p623.c; create type p623.c as enum ('x','y','z'); create table p623.ce (id int primary key, c p623.c)",
);
await attempt("after recreate", () => q("select id from p623.ce where c = $1", ["x"]));
await attempt("after recreate (2nd)", () => q("select id from p623.ce where c = $1", ["x"]));

console.log("case 5: SELECT * after added column (row description change)");
await exec("create table p623.w (id int primary key, a int); insert into p623.w values (1,1)");
await attempt("before", () => q("select * from p623.w"));
await exec("alter table p623.w add column b int default 7");
await attempt("after add column", () => q("select * from p623.w"));

await exec("drop schema p623 cascade");
await sql.end();
