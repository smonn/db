/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// What type OID does the server report for a domain-typed column? (v4 re-prepares only when the described OIDs differ.)
import { pathToFileURL } from "node:url";
const postgres = (await import(pathToFileURL(process.argv[2]).href)).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
await sql
  .unsafe(
    "drop schema if exists dsc cascade; create schema dsc; create domain dsc.d as integer; create type dsc.m as enum ('a'); create table dsc.t (id int primary key, v dsc.d, m dsc.m)",
  )
  .simple();
const oids = (
  await sql.unsafe(
    "select 'dsc.d'::regtype::oid as dom, 'dsc.m'::regtype::oid as enm, 'int4'::regtype::oid as int4",
  )
)[0];
const d = await sql.unsafe("select v, m from dsc.t where id = $1").describe();
console.log(
  "oids:",
  JSON.stringify(oids),
  "| described columns:",
  JSON.stringify(d.columns.map((c) => [c.name, c.type])),
);
await sql.unsafe("drop schema dsc cascade").simple();
await sql.end();
