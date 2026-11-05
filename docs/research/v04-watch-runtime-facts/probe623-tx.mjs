/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// #623 when the DDL and the stale statement share one transaction (v4 retries only outside a transaction, per its changelog).
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
console.log("postgres", process.argv[2]);
await driver.session(async (s) => {
  await s.execute(
    "drop schema if exists x623 cascade; create schema x623; create table x623.t (id int primary key, v integer); insert into x623.t values (1, 1)",
  );
  await attempt("prepare statement before DDL", () =>
    s.query("select v from x623.t where v = $1", [1]),
  );
  await attempt("DDL and the stale statement in one transaction", () =>
    s.transaction(async (t) => {
      await t.execute("alter table x623.t alter column v type text using v::text");
      return t.query("select v from x623.t where v = $1", ["abc"]);
    }),
  );
  await s.execute("drop schema x623 cascade");
});
await sql.end();
