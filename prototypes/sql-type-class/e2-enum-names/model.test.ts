// Type tests for enum option E2. tsc checks them; nothing runs.
import { c, defineEnum, ref } from "./model.ts";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
declare function check<T extends true>(): void;
type ClassOf<Col> = Col extends { readonly "~types": { readonly sqlClass: infer C } } ? C : never;
type ValueOf<Col> = Col extends { readonly "~types": { readonly value: infer V } } ? V : never;

const mood = defineEnum("mood", ["sad", "ok", "happy"]);
const mood2 = defineEnum("mood2", ["sad", "ok", "happy"]);
const mini = defineEnum("mini", ["sad", "ok"]);
// The same SQL name in another schema: E2 can't tell `public.mood` from `audit.mood`.
const auditMood = defineEnum("mood", ["sad", "ok", "happy", "angry"]);
const named: string = "mood";
const wide = defineEnum(named, ["sad", "ok", "happy"]);

export function pins(): void {
  const m = c.enum(mood);
  check<Equal<ClassOf<typeof m>, "enum:mood">>();
  check<Equal<ValueOf<typeof m>, "sad" | "ok" | "happy">>();
  const a = c.enum(mood).array();
  check<Equal<ClassOf<typeof a>, "enum:mood[]">>();
  const w = c.enum(wide);
  check<Equal<ClassOf<typeof w>, `enum:${string}`>>();
}

export function enumsByName(): void {
  const m = ref(c.enum(mood));
  const txt = ref(c.text());
  m.eq(ref(c.enum(mood)));
  m.eq("ok");
  // Postgres refuses `public.mood = audit.mood`; the names match, so it compiles.
  m.eq(ref(c.enum(auditMood)));
  // @ts-expect-error -- two enums with the same labels
  m.eq(ref(c.enum(mood2)));
  // @ts-expect-error -- arrays of two enums with the same labels
  ref(c.enum(mood).array()).eq(ref(c.enum(mood2).array()));
  // @ts-expect-error -- an enum against one with a subset of its labels
  m.eq(ref(c.enum(mini)));
  // @ts-expect-error -- enum = text
  m.eq(txt);
  // @ts-expect-error -- a name that isn't a literal widens the class, so nothing matches it
  m.eq(ref(c.enum(wide)));
  // A widened class still accepts any enum class: `enum:${string}` takes `enum:mood`.
  ref(c.enum(wide)).eq(m);
}
