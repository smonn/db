// PROTOTYPE for #774, throwaway: how `smonndb generate --watch` looks in a terminal.
// Run: node prototypes/watch-output/watch-output.ts [a|b|c] [--fast]
// Plays one scripted session (start, a change, a no-change save, a failed run, its recovery)
// in the chosen variant. Nothing here touches a database.

type Run =
  | { kind: "start" }
  | { kind: "change"; trigger: string; ms: number }
  | { kind: "same"; trigger: string; ms: number }
  | { kind: "fail"; trigger: string; ms: number }
  | { kind: "recover"; trigger: string; ms: number };

const session: { at: string; run: Run; pause: number }[] = [
  { at: "14:02:11", run: { kind: "start" }, pause: 1800 },
  { at: "14:02:40", run: { kind: "change", trigger: "src/db/schema.ts", ms: 212 }, pause: 1800 },
  { at: "14:03:05", run: { kind: "same", trigger: "src/db/schema.ts", ms: 148 }, pause: 1800 },
  { at: "14:03:31", run: { kind: "fail", trigger: "src/db/tables/users.ts", ms: 96 }, pause: 2200 },
  {
    at: "14:03:52",
    run: { kind: "recover", trigger: "src/db/tables/users.ts", ms: 231 },
    pause: 0,
  },
];

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const bold = paint(1);

const WATCHED = "watching 7 files in 3 folders and migrations/ (Ctrl-C to stop)";
const ERROR = [
  "src/db/tables/users.ts:14:21 - TypeError: text(...).unique is not a function",
  "    at loadDefinition (src/db/schema.ts:3:1)",
];
// What a successful run prints today (report.ts), with #768's outcome line in place of "reset".
const reports: Record<Exclude<Run["kind"], "fail" | "same">, string[]> = {
  start: [
    "wrote migrations/current.sql",
    "caught up the Dev database: replayed migrations/current.sql",
  ],
  change: [
    "wrote migrations/current.sql",
    "hazard drop_column: ALTER TABLE users DROP COLUMN nickname;",
    "caught up the Dev database: diffed it, applying 1 Hazard",
  ],
  recover: [
    "wrote migrations/current.sql",
    "caught up the Dev database: replayed migrations/current.sql",
  ],
};

const variants: Record<string, (at: string, run: Run) => void> = {
  // A: append-only log. One timestamped status line per run, report lines indented under it.
  a(at, run) {
    const t = dim(at);
    if (run.kind === "start") {
      console.log(`${t} ${WATCHED}`);
      console.log(`${t} ${green("ok")} initial run ${dim("(301 ms)")}`);
      for (const l of reports.start) console.log(`         ${l}`);
      return;
    }
    const why = dim(`${run.trigger} changed, ${run.ms} ms`);
    if (run.kind === "same") return console.log(`${t} ${green("ok")} no change ${why}`);
    if (run.kind === "fail") {
      console.log(`${t} ${red("failed")} ${why}`);
      for (const l of ERROR) console.log(`         ${l}`);
      console.log(`         ${yellow("kept the Dev database from the 14:02:40 run")}`);
      return;
    }
    console.log(`${t} ${green("ok")} ${run.kind === "recover" ? "fixed " : ""}${why}`);
    for (const l of reports[run.kind]) console.log(`         ${l}`);
  },

  // B: clear and redraw, like tsc --watch. The screen always shows the latest run only.
  b(at, run) {
    if (tty) process.stdout.write("\x1b[2J\x1b[H");
    const header = (state: string) =>
      console.log(`${bold("smonndb generate --watch")}  ${state}  ${dim(`last run ${at}`)}\n`);
    if (run.kind === "start") {
      header(green("● up to date"));
      for (const l of reports.start) console.log(l);
    } else if (run.kind === "same") {
      header(green("● up to date"));
      console.log(`no change ${dim(`(${run.trigger}, ${run.ms} ms)`)}`);
    } else if (run.kind === "fail") {
      header(red("● failed"));
      for (const l of ERROR) console.log(l);
      console.log(`\n${yellow("the Dev database still matches the 14:02:40 run")}`);
    } else {
      header(green("● up to date"));
      console.log(dim(`${run.trigger}, ${run.ms} ms`));
      for (const l of reports[run.kind]) console.log(l);
    }
    console.log(`\n${dim(WATCHED)}`);
  },

  // C: plain grouped runs, no timestamps or colors beyond red errors; a rule between runs.
  c(_at, run) {
    if (run.kind === "start") {
      console.log(WATCHED);
      console.log("");
      for (const l of reports.start) console.log(l);
      return;
    }
    console.log(dim(`\n── ${run.trigger} ──`));
    if (run.kind === "same") return console.log("no change");
    if (run.kind === "fail") {
      for (const l of ERROR) console.log(red(l));
      console.log("failed; the Dev database is unchanged; watching for the next save");
      return;
    }
    for (const l of reports[run.kind]) console.log(l);
  },
};

const variant = process.argv[2] ?? "a";
const fast = process.argv.includes("--fast");
const show = variants[variant];
if (show === undefined) throw new Error(`variant must be a, b, or c, not ${variant}`);

console.log(dim(`$ smonndb generate --watch    [prototype variant ${variant}]`));
for (const { at, run, pause } of session) {
  show(at, run);
  if (!fast) await new Promise((r) => setTimeout(r, pause));
}
if (variant !== "b") console.log(dim("^C"));
console.log(variant === "a" ? `${dim("14:04:10")} stopped` : "stopped watching");
