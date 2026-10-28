# PROTOTYPE: query type errors (#656)

Throwaway. Lives only on `prototype/query-type-errors`; never merge it.

## Question

Can TypeScript print a useful error for a name-list `select` and for `insert().values()`? Pass bar: the error names the bad key (or the missing one) and the table's real keys, without a `No overload matches` that blames the wrong signature.

## Run

From the repo root, with the repo's TypeScript (7.0.2):

- `node prototypes/query-type-errors/report.ts` type-checks the folder and rewrites `errors.md`: every bad call in `probes.ts` under its case label, then any failed check in `checks.ts`.
- `checks.ts` asserts the inferred row types and that a one-row insert fits `client.one` while a multi-row one doesn't. Two checks fail on purpose: S3's callback form and I9's runtime array (see below). The failure of S3 also shows the checks run.

No `demo.ts`: every variant is type-only over the same runtime, so outputs can't differ.

## Variants

`variants.ts`. Select: S0 today (callback only); S1 overloads, names first; S2 overloads, names last; S3 one generic signature over both forms; S4 a second method `pick(...names)`; S5 S1 with the key type inline; S6 S2 with the key type inline.

Insert: I0 today (overloads, array last); I1 overloads, row last; I2 one generic signature; I3 I2 plus an excess-key guard; I4 two methods `values`/`valuesMany`; I5 I4 with a flattening alias; I6 I1 with that alias; I7 I1 with the row type inline; I8 I4 with the row type inline; I9 rows as arguments, overloaded by count.

## Verdict

| Variant    | Wrong name/key                     | Missing required      | Wrong type            | Rows                | Note                                                           |
| ---------- | ---------------------------------- | --------------------- | --------------------- | ------------------- | -------------------------------------------------------------- |
| S1, S5     | names it, unless one name          | n/a                   | n/a                   | n/a                 | `select("nope")` blames the callback overload, prints `string` |
| S2, S6     | names it                           | n/a                   | n/a                   | n/a                 | a callback returning a non-column blames the names overload    |
| S3         | names it                           | n/a                   | n/a                   | n/a                 | out: breaks callback inference                                 |
| S4         | names it                           | n/a                   | n/a                   | n/a                 | clean in every case; costs a second method                     |
| I0         | blames array overload, names `id`  | blames array overload | blames array overload | names `nope`        | today's behavior                                               |
| I1, I6, I7 | names it                           | names it              | names it              | blames row overload | row-last flips which case misreports                           |
| I2         | **no error**                       | names it              | names it              | **no error**        | out: generic skips excess-key checks                           |
| I3         | `string` not assignable to `never` | huge intersection     | names it              | unreadable          | out                                                            |
| I4, I5, I8 | names it                           | names it              | names it              | names it            | clean in every case; costs a second method                     |
| I9         | names it                           | names it              | names it              | names it            | out: a runtime array can't spread into it                      |

Findings:

1. An overload pair always misreports the call that only its first signature fits: tsc reports the last one. Arity can hide this (S1's two-name call rules out the one-argument callback overload), but some call always shares an arity.
2. Separate methods (S4, I8) report every case plainly, with no `No overload matches` prefix.
3. A parameter type written inline prints its keys (`'"email" | "id" | "name"'`, `'{ email?: string | null; id: string; name?: string | null; }'`). Through an alias (`Key<T>`, `NewRow<T>`, even a flattening `FlatRow<T>`) tsc prints the alias with the whole `Table<{ id: Column<string, true, false, ...> }>` behind it. Wide tables truncate to `... 6 more ...` either way.
4. The `Many` marker survives every variant except the ones ruled out above, including I2's conditional return type; a single generic signature fails on excess keys, not on the marker.
5. Check time is 0.07 s for the whole folder; no variant stands out.
