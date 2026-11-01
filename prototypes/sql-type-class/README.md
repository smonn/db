# Prototype: the SQL type class on `Column`

Throwaway probe for #709. Two questions: does the class replace `Int` or sit beside it (Q1), and how does an enum's class tell enums apart (Q2)? Types-only models of `Column` with #571's flags object, one folder per shape. Nothing here runs except `e1-runtime-check`.

## Verdict

| Question              | Recommendation                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Q1: replace or beside | **A, beside.** This contradicts #709's "replaces `Int`", so the issue needs amending.           |
| Q2: enum class        | **E1, labels plus a build-time check**, and widen the check to arrays and domains over an enum. |

Q1 reasons. Both shapes pass every case the brief named, and cost within 2% of each other. They differ only where identity and comparability come apart: Postgres refuses an identity on a domain over integer, but compares that domain with integer. A keeps the two facts in two fields. B folds them into one class, so it compiles `c.domain(posint).identity()`. Its fix maps a domain's `integer` to `decimal`, which makes `"decimal"` mean "a number with no identity". B saves one boolean, and its errors print `ColumnOperand<Comparable<"integer">>` without resolving it.

Q2 reasons. Neither class shape closes the array gap: Postgres compares an array only with the identical element type, and neither A nor B tracks that. So a runtime check is needed anyway. E1's check covers enums, arrays, and domains over an enum in 20 lines with no type cost. E2 changes `defineEnum`'s signature, and its names repeat the schema key. It still compiles `public.mood = audit.mood`, and a non-literal name widens the class to `` `enum:${string}` ``.

## Layout

- `baseline/`: #571's flags with `int` and no class. Operands match by TS value type, the rule #658 decided before alternative D.
- `a-beside/`: flags `{ int; sqlClass }`. Classes: `text`, `number`, `boolean`, `uuid`, `time`, `jsonb`, `bytea`, `enum:<labels>`, plus `[]` for arrays. `identity()` reads `int`. An operand must have an equal class.
- `b-replaces/`: `sqlClass` only, with `number` split into `integer` and `decimal`. `identity()` reads `sqlClass extends "integer"`, and operands match through a `Comparisons` lookup (`integer` with `decimal`).
- `e2-enum-names/`: A, with the enum's class taken from a literal name.
- `e1-runtime-check/`: `assertComparable(left, right)` and its `node:test` tests, run against the real `src` factories.
- Each model folder holds `model.ts`, `model.test.ts` (type tests; each `@ts-expect-error` is a refusal quoted below), and `usage.ts`. `usage.ts` is a 4-table, 31-column schema with 12 comparisons, identical in every shape except E2's `defineEnum` line, so the cost compares like for like.

## What a user writes

Definitions are the same in A and B. Only the printed class differs.

```ts
const posint = defineDomain((b) => b.integer(), { notNull: true });
const users = {
  id: c.integer().identity(),
  karma: c.domain(posint),
  score: c.numeric(10, 2),
  token: c.uuid(),
  handle: c.text(),
};

ref(users.id).eq(ref(users.score)); // A and B: ok (Postgres: ok)
ref(users.token).eq(ref(users.handle)); // A and B: TS2345, "text" is not assignable to "uuid"
c.numeric().identity(); // A and B: TS2339
c.domain(posint).identity(); // A: TS2339. B: compiles, and Postgres refuses it
```

E2 changes how an enum is declared:

```ts
const mood = defineEnum(["sad", "ok", "happy"]); // A, B, E1, E3
const mood = defineEnum("mood", ["sad", "ok", "happy"]); // E2: the name is a literal type argument
```

## Postgres facts

PostgreSQL 18.6, `select 1 from t t1 join t t2 on t1.a = t2.b` unless noted. Rows marked new were not in the joins probe.

| Case                                                                         | Postgres                                                    | A                                 | B                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- | --------------------------------- |
| identity on integer, bigint                                                  | ok                                                          | ok                                | ok                                |
| identity on numeric                                                          | `identity column type must be smallint, integer, or bigint` | refuses                           | refuses                           |
| identity on a domain over integer (new)                                      | same error                                                  | refuses                           | **compiles**                      |
| integer = bigint, integer = numeric, integer = real, numeric = double        | ok                                                          | ok                                | ok                                |
| integer = domain over integer, text = domain over text, text = varchar       | ok                                                          | ok                                | ok                                |
| date = timestamp, timestamp = timestamptz                                    | ok                                                          | ok                                | ok                                |
| uuid = text, boolean = integer                                               | `operator does not exist`                                   | refuses                           | refuses                           |
| integer[] = bigint[] (new)                                                   | `operator does not exist: integer[] = bigint[]`             | **compiles**                      | **compiles**                      |
| integer[] = numeric[] (new)                                                  | `operator does not exist`                                   | **compiles**                      | refuses                           |
| text[] = varchar[], text[] = domain-over-text[] (new)                        | `operator does not exist`                                   | **compiles**                      | **compiles**                      |
| integer[] = smallint[], real[] = double[], timestamp[] = timestamptz[] (new) | `operator does not exist`                                   | same class, so compiles (no test) | same class, so compiles (no test) |
| varchar(10)[] = varchar(20)[], numeric(10,2)[] = numeric[] (new)             | ok                                                          | ok                                | ok                                |
| integer[] = text[]                                                           | `operator does not exist`                                   | refuses                           | refuses                           |
| mood = mood2, same labels                                                    | `operator does not exist: mood = mood2`                     | compiles (E3 gap)                 | compiles (E3 gap)                 |
| mood = mini, a subset of its labels                                          | `operator does not exist`                                   | refuses both ways                 | refuses both ways                 |
| mood = text                                                                  | `operator does not exist: mood = text`                      | refuses                           | refuses                           |
| mood = a domain over mood (new)                                              | `operator does not exist: m1 = dm1`                         | **compiles**                      | **compiles**                      |
| `t.text = any(t.varchar_array)`, `t.int = any(t.posint_array)`               | ok                                                          | n/a                               | n/a                               |

So an array, an enum, and a domain over an enum compare only with the identical type. A domain over a scalar compares with its base. `any()` (`includes`) is lenient.

## Q1 results

Every brief case passes in both shapes: class pins for all 17 factories, a domain, and an array; identity on integer ok and on numeric refused; integer = bigint ok; integer = numeric ok; uuid = text refused; text = domain over text ok; `like` only on the text class (text, varchar, domain over text); `includes` only on arrays (refused on `jsonb<string[]>()`). Row types are pinned unchanged.

| Measure                                                    | Baseline | A                 | B                                                      |
| ---------------------------------------------------------- | -------- | ----------------- | ------------------------------------------------------ |
| Instantiations, model + usage                              | 6,629    | 7,992 (+20.6%)    | 7,842 (+18.3%)                                         |
| Types, model + usage                                       | 2,308    | 2,749             | 2,794                                                  |
| Instantiations, with type tests (A has one more test line) | n/a      | 14,319            | 14,232                                                 |
| Check time, model + usage                                  | 0.003 s  | 0.004 s           | 0.004 s                                                |
| Lines of type code in `model.ts` (no comments)             | 126      | 162               | 158                                                    |
| Flag fields a reader learns                                | `int`    | `int`, `sqlClass` | `sqlClass`                                             |
| Other concepts                                             | none     | class equality    | `Comparisons` lookup; `integer` means "takes identity" |
| Domain over integer takes `identity()`                     | no       | no                | **yes**                                                |
| Array gaps that compile (of 3 tested)                      | n/a      | 3                 | 2                                                      |

`tsc --noEmit --extendedDiagnostics -p <shape>/tsconfig.cost.json` (and `tsconfig.json` for the tests), tsc 7.0.2, three runs. Instantiations were identical on every run, and check time is the median. An empty program costs 0 instantiations, so every count here comes from the model. These percentages are model-only and overstate the project-wide effect. The joins probe measured a 10th `Column` parameter at +7.4% project-wide when written inline.

B's fix for the domain gap, tried in a scratch copy: `domain` returns `Fresh<C extends "integer" ? "decimal" : C, N>`. Then `c.domain(posint).identity()` fails with `Property 'identity' does not exist on type 'Column<number, Fresh<"decimal", true>>'`, and `int.eq(posint)` still compiles. But the domain's class now reads `"decimal"`.

B only refuses integer[] = numeric[] because `Comparisons` has no array entries. Closing the array gaps at the type level needs the exact element type in the class, as in `integer[]` apart from `bigint[]`, plus a domain's identity. Neither shape carries that, and E1's check covers it at build time.

### Q1 error texts (tsc 7, `--pretty false`)

Every TS2345 names the operand's type and both classes. Every TS2339 names the method and the receiver's class. None prints a wall. First lines:

```
identity on numeric
  A  TS2339: Property 'identity' does not exist on type 'Column<string, Fresh<"number", false, false>>'.
  B  TS2339: Property 'identity' does not exist on type 'Column<string, Fresh<"decimal", false>>'.
identity on a domain over integer
  A  TS2339: Property 'identity' does not exist on type 'Column<number, Fresh<"number", false, true>>'.
  B  compiles
identity after a default
  A  TS2339: Property 'identity' does not exist on type 'Column<number, With<Fresh<"number", true, false>, { readonly generated: true; readonly fresh: false; }>>'.
uuid = text (A and B)
     TS2345: Argument of type 'Ref<string, "text">' is not assignable to parameter of type 'string | ColumnOperand<"uuid">'.
       Type 'Ref<string, "text">' is not assignable to type 'ColumnOperand<"uuid">'.
         Types of property '"~class"' are incompatible.
           Type '"text"' is not assignable to type '"uuid"'.
integer = text
  A  TS2345: Argument of type 'Ref<string, "text">' is not assignable to parameter of type 'number | ColumnOperand<"number">'.
  B  TS2345: Argument of type 'Ref<string, "text">' is not assignable to parameter of type 'number | ColumnOperand<Comparable<"integer">>'.
       ... Type '"text"' is not assignable to type 'Comparable<"integer">'.
integer[] = text[]
  A  TS2345: Argument of type 'Ref<(string | null)[], "text[]">' is not assignable to parameter of type '(number | null)[] | ColumnOperand<"number[]">'.
like on uuid / an enum / text[] (A and B)
     TS2339: Property 'like' does not exist on type 'Ref<string, "uuid">'.
     TS2339: Property 'like' does not exist on type 'Ref<"happy" | "ok" | "sad", "enum:sad,ok,happy">'.
     TS2339: Property 'like' does not exist on type 'Ref<(string | null)[], "text[]">'.
includes on text / jsonb<string[]>, and a wrong element (A and B)
     TS2339: Property 'includes' does not exist on type 'Ref<string, "text">'.
     TS2339: Property 'includes' does not exist on type 'Ref<string[], "jsonb">'.
     TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

A's identity error hides the reason in a positional `Fresh<…, false, …>`. That is this model's `Fresh` alias. Under #571's named flags it would print `int: false`. B's prints the reason as the class.

## Q2 results

| Case                            | E3: labels only            | E1: labels + build-time check                     | E2: literal enum name                                             |
| ------------------------------- | -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| mood = mood2, same labels       | compiles; Postgres refuses | compiles; the builder throws, naming both columns | TS2345                                                            |
| mood = mini, a subset           | TS2345 both ways           | TS2345 both ways                                  | TS2345                                                            |
| mood = text                     | TS2345                     | TS2345                                            | TS2345                                                            |
| mood = a domain over mood       | compiles; Postgres refuses | throws                                            | not modelled                                                      |
| `public.mood` = `audit.mood`    | compiles if labels match   | throws                                            | **compiles**: same name                                           |
| mood[] = mood2[]                | compiles                   | throws                                            | TS2345 (`enum:mood[]`)                                            |
| Instantiations, model + usage   | 7,992 (A)                  | 7,992; the check adds no types                    | 7,816 (−176)                                                      |
| Instantiations, with type tests | 14,319 (A)                 | 14,319                                            | 8,758 (fewer tests)                                               |
| API change                      | none                       | none                                              | `defineEnum(name, labels)`, and `Enum<L, Name>` gains a parameter |

E1's message, from `check.test.ts` (8 tests pass under `node --test`):

```
Error: Can't compare users.mood with posts.mood: Postgres compares an enum, a domain over one, or an array only with the identical type
```

Beyond the brief, the check also throws for integer[] = bigint[], text[] = varchar[], text[] = domain[], mood[] = mood2[], and a domain over mood = mood. It passes varchar(10)[] = varchar(20)[], numeric(10,2)[] = numeric[], integer = numeric, and text = a domain over text. Each matches Postgres above. It compares `state.domainType ?? state.enumType ?? sqlType-without-modifiers` by identity.

E2 errors (`e2-enum-names/model.test.ts`):

```
mood = mood2   TS2345: Argument of type 'Ref<"happy" | "ok" | "sad", "enum:mood2">' is not assignable to parameter of type 'ColumnOperand<"enum:mood"> | NonNullable<"happy" | "ok" | "sad">'.
                 ... Type '"enum:mood2"' is not assignable to type '"enum:mood"'.
mood = mini    TS2345: ... 'Ref<"ok" | "sad", "enum:mini">' is not assignable to parameter of type 'ColumnOperand<"enum:mood"> | ...'.
mood = text    TS2345: ... 'Ref<string, "text">' is not assignable to parameter of type 'ColumnOperand<"enum:mood"> | ...'.
mood = an enum named by a `string` variable
               TS2345: ... Type '`enum:${string}`' is not assignable to type '"enum:mood"'.
```

The other way round, a column whose name widened accepts every enum as an operand.

E3 and E1 subset errors (A and B alike):

```
mood = mini    TS2345: Argument of type 'Ref<"ok" | "sad", "enum:sad,ok">' is not assignable to parameter of type 'ColumnOperand<"enum:sad,ok,happy"> | NonNullable<"happy" | "ok" | "sad">'.
                 ... Type '"enum:sad,ok"' is not assignable to type '"enum:sad,ok,happy"'.
```

The labels class costs more as an enum grows. A non-tail-recursive `Join` (`` `${H},${Join<R>}` ``) fails with `TS2589: Type instantiation is excessively deep and possibly infinite` from 48 labels. The committed tail-recursive form compiles 999 labels but grows quadratically: one enum of 5 labels costs 14,629 instantiations for the whole A tree, 50 labels 18,049, 100 labels 26,599, and 200 labels 58,699. The joins probe's union form (`` `enum:${L[number]}` ``) is linear, but `mood.eq(mini)` compiles under it, while `mini.eq(mood)` refuses.

## Reproduce

- `pnpm exec tsc --noEmit` checks everything: the root `tsconfig.json` includes `prototypes` on this branch.
- Cost: `pnpm exec tsc --noEmit --extendedDiagnostics -p prototypes/sql-type-class/<shape>/tsconfig.cost.json`.
- Error texts: copy a shape folder, replace each `// @ts-expect-error` with a plain comment, and run tsc on the copy.
- E1: `node --test prototypes/sql-type-class/e1-runtime-check/check.test.ts`.

## Open for the real design

- With E1 catching enum mismatches at build time, the enum class could drop its labels (`"enum"`), with no `Join` cost. Then a subset-label enum fails at build time rather than at compile time.
- E1 needs the column's state at the operand path, and the left-hand column's label, which `ColumnRef` doesn't carry today.
- `.codec()` keeps the class here (`c.integer().codec(...)` stays `number`), as in the order probe's open question.
- An untyped `jsonb()` column accepts any column as an operand: `T = unknown` makes `eq`'s value side `{}`, so `ref(c.jsonb()).eq(ref(c.uuid()))` compiles in a scratch copy. `jsonb<{ a: number }>()` refuses it. The joins probe told the two apart at run time with a `WeakMap`.
