/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node probe623-reset.mjs <postgres entry> — v4's domain-select failure and ways out of it.
import { attempt } from "./attempt.mjs";
import { pathToFileURL } from "node:url";
const entry = process.argv[2];
const postgres = (await import(pathToFileURL(entry).href)).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const prep = { prepare: true, simple: false };
const q = (text, params = []) => sql.unsafe(text, params, prep);
const exec = (script) => sql.unsafe(script).simple();
const stmt = "select v from p623r.dd where id = $1";
const redo =
  "drop table p623r.dd; drop domain p623r.d; create domain p623r.d as integer; create table p623r.dd (id int primary key, v p623r.d); insert into p623r.dd values (1, 1)";
await exec(
  "drop schema if exists p623r cascade; create schema p623r; create domain p623r.d as integer; create table p623r.dd (id int primary key, v p623r.d); insert into p623r.dd values (1, 1)",
);
await attempt("before", () => q(stmt, [1]));
await exec(redo);
for (let i = 1; i <= 3; i++) await attempt(`after domain recreate (${i})`, () => q(stmt, [1]));
await attempt("pg_prepared_statements", () => exec("select name from pg_prepared_statements"));
console.log("variant: DEALLOCATE ALL on the connection");
await exec("deallocate all");
await attempt("after deallocate all", () => q(stmt, [1]));
await attempt("again", () => q(stmt, [1]));
console.log("variant: sql.close() then reuse the pool");
await exec(redo);
await attempt("after recreate (fails?)", () => q(stmt, [1]));
await sql.close?.();
await attempt("after sql.close()", () => q(stmt, [1]));
console.log("variant: prepare:false");
await exec(redo);
await attempt("prepare:false after recreate", () =>
  sql.unsafe(stmt, [1], { prepare: false, simple: false }),
);
await exec("drop schema p623r cascade");
await sql.end();
