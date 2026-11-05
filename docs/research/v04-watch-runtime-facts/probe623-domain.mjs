/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node probe623-domain.mjs <postgres entry> [max]  — the domain case alone, with variants.
import { attempt } from "./attempt.mjs";
import { pathToFileURL } from "node:url";
const entry = process.argv[2];
const max = Number(process.argv[3] ?? 1);
const postgres = (await import(pathToFileURL(entry).href)).default;
const sql = postgres(process.env.DATABASE_URL, { max, onnotice: () => {} });
const prep = { prepare: true, simple: false };
const q = (text, params = []) => sql.unsafe(text, params, prep);
const exec = (script) => sql.unsafe(script).simple();
console.log("entry", entry, "max", max);

console.log(
  "3a: domain over integer, drop+recreate domain with different constraint (via table recreate)",
);
await exec("drop schema if exists p623d cascade; create schema p623d;");
await exec(
  "create domain p623d.d as integer; create table p623d.dd (id int primary key, v p623d.d); insert into p623d.dd values (1, 1)",
);
await attempt("before", () => q("select v from p623d.dd where id = $1", [1]));
await exec(
  "drop table p623d.dd; drop domain p623d.d; create domain p623d.d as integer check (value > 0); create table p623d.dd (id int primary key, v p623d.d); insert into p623d.dd values (1, 1)",
);
await attempt("after (1)", () => q("select v from p623d.dd where id = $1", [1]));
await attempt("after (2)", () => q("select v from p623d.dd where id = $1", [1]));

console.log("3b: domain column, insert with domain param");
await exec(
  "drop schema p623d cascade; create schema p623d; create domain p623d.d as integer; create table p623d.dd (id int primary key, v p623d.d)",
);
await attempt("before insert", () =>
  q("insert into p623d.dd (id, v) values ($1, $2) on conflict (id) do nothing", [1, 1]),
);
await exec(
  "drop table p623d.dd; drop domain p623d.d; create domain p623d.d as integer; create table p623d.dd (id int primary key, v p623d.d)",
);
await attempt("after insert (1)", () =>
  q("insert into p623d.dd (id, v) values ($1, $2) on conflict (id) do nothing", [2, 1]),
);
await attempt("after insert (2)", () =>
  q("insert into p623d.dd (id, v) values ($1, $2) on conflict (id) do nothing", [3, 1]),
);
await exec("drop schema p623d cascade");
await sql.end();
