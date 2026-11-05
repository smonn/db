/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// v4: stale statements with another statement pipelined behind them on the same connection (PR #1257 says: fail once, then re-prepare).
import { pathToFileURL } from "node:url";
const postgres = (await import(pathToFileURL(process.argv[2]).href)).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params, { prepare: true, simple: false });
const settle = (p) =>
  p.then(
    (r) => "OK " + JSON.stringify(r),
    (e) => `FAIL ${e.code} ${e.message}`,
  );
await sql
  .unsafe(
    "drop schema if exists pl cascade; create schema pl; create table pl.t (id int primary key, v integer); insert into pl.t values (1, 1)",
  )
  .simple();
await q("select v from pl.t where v = $1", [1]);
await q("select id from pl.t where id = $1", [1]);
await sql.unsafe("alter table pl.t alter column v type text using v::text").simple();
const results = await Promise.all([
  settle(q("select v from pl.t where v = $1", ["abc"])),
  settle(q("select v from pl.t where v = $1", ["abc"])),
  settle(q("select id from pl.t where id = $1", [1])),
]);
console.log("two stale statements + one fresh, issued together on max:1:", results);
console.log(
  "same stale text again, alone:",
  await settle(q("select v from pl.t where v = $1", ["abc"])),
);
await sql.unsafe("drop schema pl cascade").simple();
await sql.end();
