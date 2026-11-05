/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node probe-lock.mjs <postgres entry>
// Session advisory lock facts, and how a reserved postgres.js connection keeps one across many runs.
import { pathToFileURL } from "node:url";
const postgres = (await import(pathToFileURL(process.argv[2]).href)).default;
const url = process.env.DATABASE_URL;
const KEY = "7666632338"; // DEV_LOCK_KEY
const try1 = (s) =>
  s.unsafe(`select pg_try_advisory_lock(${KEY}) as locked`).then((r) => r[0].locked);
const unlock = (s) =>
  s.unsafe(`select pg_advisory_unlock(${KEY}) as released`).then((r) => r[0].released);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const holders = async (admin) =>
  (
    await admin.unsafe(
      `select count(*)::int as n from pg_locks where locktype='advisory' and granted`,
    )
  )[0].n;

const admin = postgres(url, { max: 1 });
const a = postgres(url, { max: 1 });
const b = postgres(url, { max: 1 });
console.log("postgres.js entry", process.argv[2].split("/").slice(-5, -3).join("/"));

console.log("1. re-entrancy and stacking");
console.log(
  "  A try:",
  await try1(a),
  "| A try again:",
  await try1(a),
  "| pg_locks rows:",
  await holders(admin),
);
console.log("  B try while A holds (x2):", await try1(b));
console.log(
  "  A unlock once:",
  await unlock(a),
  "| B try (A still holds one level):",
  await try1(b),
);
console.log(
  "  A unlock twice:",
  await unlock(a),
  "| A unlock third time (not held):",
  await unlock(a),
);
console.log("  B try after A fully released:", await try1(b), "| B releases:", await unlock(b));

console.log("2. pg_advisory_unlock_all releases every level");
await try1(a);
await try1(a);
await try1(a);
await a.unsafe("select pg_advisory_unlock_all()");
console.log("  B try after A's unlock_all with 3 levels:", await try1(b));
await unlock(b);

console.log("3. a lock survives rollback and failed statements");
await a
  .unsafe("begin; select pg_try_advisory_lock(" + KEY + ");")
  .simple()
  .catch((e) => console.log("  err", e.message));
await a.unsafe("rollback").simple();
console.log("  B try after A's rolled-back acquire:", await try1(b), "(false = still held)");
await a.unsafe("select pg_advisory_unlock_all()");

console.log("4. keys are per database");
await admin.unsafe("drop database if exists lockprobe_other").simple();
await admin.unsafe("create database lockprobe_other").simple();
const other = postgres(url.replace(/\/[^/]*$/, "/lockprobe_other"), { max: 1 });
await try1(a);
console.log("  A holds in db 1; same key from a session in another database:", await try1(other));
await a.unsafe("select pg_advisory_unlock_all()");
await other.end();
await admin.unsafe("drop database lockprobe_other").simple();

console.log("5. backend termination releases the lock");
await try1(a);
const pid = (await a.unsafe("select pg_backend_pid() as pid"))[0].pid;
await admin.unsafe(`select pg_terminate_backend(${pid})`);
await sleep(300);
console.log("  B try after A's backend was terminated:", await try1(b));
await unlock(b);
await a.end().catch(() => {});

console.log(
  "6. a reserved connection held across runs, with pool timers that would recycle an idle pooled connection",
);
const pool = postgres(url, { max: 2, idle_timeout: 1, max_lifetime: 2 });
const reserved = await pool.reserve();
const pid0 = (await reserved.unsafe("select pg_backend_pid() as pid"))[0].pid;
console.log("  reserved takes lock:", await try1(reserved), "| pid", pid0);
await sleep(5000);
const pid1 = (await reserved.unsafe("select pg_backend_pid() as pid"))[0].pid;
console.log(
  "  after 5 s idle with idle_timeout=1 and max_lifetime=2: same backend:",
  pid0 === pid1,
  "| B try (false = still held):",
  await try1(b),
);
console.log(
  "  reserved takes the lock again (re-entrant, one level deeper):",
  await try1(reserved),
);
reserved.release();
await sleep(300);
console.log(
  "  after release() without unlock_all, B try (false = pool keeps the connection, lock stays):",
  await try1(b),
);
await pool.end({ timeout: 2 });
await sleep(300);
console.log("  after pool.end(), B try:", await try1(b));
await unlock(b);

await a.end().catch(() => {});
await b.end();
await admin.end();
