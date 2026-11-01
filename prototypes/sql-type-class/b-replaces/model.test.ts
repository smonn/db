// Type tests for shape B. tsc checks them; nothing runs. Each `@ts-expect-error` is a refusal the
// README quotes, captured by compiling a copy with the directives removed.
import { c, defineDomain, defineEnum, ref } from "./model.ts";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
declare function check<T extends true>(): void;
type ClassOf<Col> = Col extends { readonly "~types": { readonly sqlClass: infer C } } ? C : never;
type ValueOf<Col> = Col extends { readonly "~types": { readonly value: infer V } } ? V : never;

const name = defineDomain((b) => b.text());
const posint = defineDomain((b) => b.integer(), { notNull: true });
const mood = defineEnum(["sad", "ok", "happy"]);
const mood2 = defineEnum(["sad", "ok", "happy"]);
const mini = defineEnum(["sad", "ok"]);

export function classPins(): void {
  check<Equal<ClassOf<ReturnType<typeof c.text>>, "text">>();
  check<Equal<ClassOf<ReturnType<typeof c.varchar>>, "text">>();
  check<Equal<ClassOf<ReturnType<typeof c.smallint>>, "integer">>();
  check<Equal<ClassOf<ReturnType<typeof c.integer>>, "integer">>();
  check<Equal<ClassOf<ReturnType<typeof c.bigint>>, "integer">>();
  check<Equal<ClassOf<ReturnType<typeof c.numeric>>, "decimal">>();
  check<Equal<ClassOf<ReturnType<typeof c.real>>, "decimal">>();
  check<Equal<ClassOf<ReturnType<typeof c.doublePrecision>>, "decimal">>();
  check<Equal<ClassOf<ReturnType<typeof c.boolean>>, "boolean">>();
  check<Equal<ClassOf<ReturnType<typeof c.uuid>>, "uuid">>();
  check<Equal<ClassOf<ReturnType<typeof c.date>>, "time">>();
  check<Equal<ClassOf<ReturnType<typeof c.timestamp>>, "time">>();
  check<Equal<ClassOf<ReturnType<typeof c.timestamptz>>, "time">>();
  check<Equal<ClassOf<ReturnType<typeof c.jsonb>>, "jsonb">>();
  check<Equal<ClassOf<ReturnType<typeof c.bytea>>, "bytea">>();
  const m = c.enum(mood);
  check<Equal<ClassOf<typeof m>, "enum:sad,ok,happy">>();
  const d = c.domain(name);
  check<Equal<ClassOf<typeof d>, "text">>();
  const p = c.domain(posint);
  check<Equal<ClassOf<typeof p>, "integer">>();
  const a = c.integer().array().notNull();
  check<Equal<ClassOf<typeof a>, "integer[]">>();
  const pa = c.domain(posint).array();
  check<Equal<ClassOf<typeof pa>, "integer[]">>();
  // Row types don't change.
  check<Equal<ValueOf<typeof a>, (number | null)[]>>();
  check<Equal<ValueOf<typeof p>, number>>();
  check<Equal<ValueOf<typeof m>, "sad" | "ok" | "happy">>();
  const coded = c.integer().codec({ decode: String, encode: Number });
  check<Equal<ClassOf<typeof coded>, "integer">>();
}

export function identityGate(): void {
  c.integer().identity();
  c.bigint().notNull().identity("always");
  // @ts-expect-error -- identity on numeric
  c.numeric().identity();
  // Compiles, but Postgres refuses: identity column type must be smallint, integer, or bigint.
  c.domain(posint).identity();
  // @ts-expect-error -- identity after a default
  c.integer().default("1").identity();
}

export function columnOperands(): void {
  const int = ref(c.integer());
  const big = ref(c.bigint());
  const num = ref(c.numeric());
  const id = ref(c.uuid());
  const txt = ref(c.text());
  const vc = ref(c.varchar(20));
  const dom = ref(c.domain(name));
  const pos = ref(c.domain(posint));
  const day = ref(c.date());
  const at = ref(c.timestamptz());
  int.eq(big);
  int.eq(num);
  int.eq(pos);
  txt.eq(vc);
  txt.eq(dom);
  day.eq(at);
  int.eq(1);
  // @ts-expect-error -- uuid = text
  id.eq(txt);
  // @ts-expect-error -- text = integer
  txt.eq(int);
  // @ts-expect-error -- integer = text
  int.eq(txt);
}

export function arrays(): void {
  const ints = ref(c.integer().array());
  const bigs = ref(c.bigint().array());
  const nums = ref(c.numeric().array());
  const texts = ref(c.text().array());
  const chars = ref(c.varchar(9).array());
  // Postgres refuses both: arrays compare only with the identical element type.
  ints.eq(bigs);
  texts.eq(chars);
  // @ts-expect-error -- integer[] = numeric[]: `Comparable` maps no array class
  ints.eq(nums);
  // @ts-expect-error -- integer[] = text[]
  ints.eq(texts);
}

export function textAndArrayMethods(): void {
  ref(c.text()).like("a%");
  ref(c.varchar(9)).like("a%");
  ref(c.domain(name)).like("a%");
  ref(c.text().array()).includes("a");
  ref(c.enum(mood).array()).includes("ok");
  // @ts-expect-error -- like on uuid
  ref(c.uuid()).like("a%");
  // @ts-expect-error -- like on an enum
  ref(c.enum(mood)).like("a%");
  // @ts-expect-error -- like on text[]
  ref(c.text().array()).like("a%");
  // @ts-expect-error -- includes on text
  ref(c.text()).includes("a");
  // @ts-expect-error -- includes on jsonb holding an array
  ref(c.jsonb<string[]>()).includes("a");
  // @ts-expect-error -- includes with a value of the wrong element type
  ref(c.integer().array()).includes("1");
}

export function enumsLabelsOnly(): void {
  const m = ref(c.enum(mood));
  const m2 = ref(c.enum(mood2));
  const small = ref(c.enum(mini));
  const txt = ref(c.text());
  // Postgres refuses: operator does not exist: mood = mood2. Labels alone can't tell them apart.
  m.eq(m2);
  m.eq(ref(c.enum(mood)));
  // Postgres refuses: operator does not exist: mood = calm. The domain keeps its base's class.
  m.eq(ref(c.domain(defineDomain((b) => b.enum(mood)))));
  // @ts-expect-error -- an enum against one with a subset of its labels
  m.eq(small);
  // @ts-expect-error -- the subset enum against the full one
  small.eq(m);
  // @ts-expect-error -- enum = text
  m.eq(txt);
  // @ts-expect-error -- text = enum
  txt.eq(m);
}
