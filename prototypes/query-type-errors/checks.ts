// PROTOTYPE for #656: correct calls must infer these types in every variant.
import type { Equal, Expect, OneArg, Query, Users } from "./core.ts";
import type {
  I0,
  I1,
  I2,
  I3,
  I4,
  I5,
  I6,
  I7,
  I8,
  I9,
  S0,
  S1,
  S2,
  S3,
  S4,
  S5,
  S6,
} from "./variants.ts";

type NameRow = { id: string; email: string | null };
type PickRow = { key: string; mail: string | null };
type Fits<Q> = Q extends OneArg<unknown> ? true : false;

declare const s0: S0<Users>;
declare const s1: S1<Users>;
declare const s2: S2<Users>;
declare const s3: S3<Users>;
declare const s4: S4<Users>;

const p0 = s0.select((u) => ({ key: u.id, mail: u.email }));
const p1 = s1.select((u) => ({ key: u.id, mail: u.email }));
const p2 = s2.select((u) => ({ key: u.id, mail: u.email }));
const p3 = s3.select((u) => ({ key: u.id, mail: u.email }));
const p4 = s4.select((u) => ({ key: u.id, mail: u.email }));
const n1 = s1.select("id", "email");
const n2 = s2.select("id", "email");
const n3 = s3.select("id", "email");
const n4 = s4.pick("id", "email");

export type SelectChecks = [
  Expect<Equal<typeof p0, Query<PickRow>>>,
  Expect<Equal<typeof p1, Query<PickRow>>>,
  Expect<Equal<typeof p2, Query<PickRow>>>,
  Expect<Equal<typeof p3, Query<PickRow>>>,
  Expect<Equal<typeof p4, Query<PickRow>>>,
  Expect<Equal<typeof n1, Query<NameRow>>>,
  Expect<Equal<typeof n2, Query<NameRow>>>,
  Expect<Equal<typeof n3, Query<NameRow>>>,
  Expect<Equal<typeof n4, Query<NameRow>>>,
];

declare const i0: I0<Users>;
declare const i1: I1<Users>;
declare const i2: I2<Users>;
declare const i3: I3<Users>;
declare const i4: I4<Users>;
declare const i5: I5<Users>;
declare const i6: I6<Users>;
declare const i7: I7<Users>;
declare const i8: I8<Users>;
declare const i9: I9<Users>;
declare const s5: S5<Users>;
const n5 = s5.select("id", "email");
declare const s6: S6<Users>;
const n6 = s6.select("id", "email");
const p6 = s6.select((u) => ({ key: u.id, mail: u.email }));
export type S5Check = Expect<Equal<typeof n5, Query<NameRow>>>;
export type S6Checks = [
  Expect<Equal<typeof n6, Query<NameRow>>>,
  Expect<Equal<typeof p6, Query<PickRow>>>,
];

const row = { id: "u1", email: "a@example.com" };

// The marker must survive: a one-row insert fits `client.one`, a multi-row one doesn't.
const pick = (u: { id: { name: string; "~value"?: string } }) => ({ id: u.id });
type Marks<A, B> = [Fits<A>, Fits<B>];

export type MarkerChecks = [
  Expect<Equal<Marks<ReturnType<typeof a0>, ReturnType<typeof b0>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a1>, ReturnType<typeof b1>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a2>, ReturnType<typeof b2>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a3>, ReturnType<typeof b3>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a4>, ReturnType<typeof b4>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a5>, ReturnType<typeof b5>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a6>, ReturnType<typeof b6>>, [true, false]>>,
];

export type MoreMarkerChecks = [
  Expect<Equal<Marks<ReturnType<typeof a7>, ReturnType<typeof b7>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a8>, ReturnType<typeof b8>>, [true, false]>>,
  Expect<Equal<Marks<ReturnType<typeof a9>, ReturnType<typeof b9>>, [true, false]>>,
];

const a7 = () => i7.values(row).returning(pick);
const b7 = () => i7.values([row]).returning(pick);
const a8 = () => i8.values(row).returning(pick);
const b8 = () => i8.valuesMany([row]).returning(pick);
const a9 = () => i9.values(row).returning(pick);
const b9 = () => i9.values(row, row).returning(pick);

// Rows built at run time arrive as an array; each variant must still take one.
declare const list: { id: string }[];
export const fromArray = [
  i0.values(list),
  i7.values(list),
  i8.valuesMany(list),
  i9.values(...list),
];

const a0 = () => i0.values(row).returning(pick);
const b0 = () => i0.values([row]).returning(pick);
const a1 = () => i1.values(row).returning(pick);
const b1 = () => i1.values([row]).returning(pick);
const a2 = () => i2.values(row).returning(pick);
const b2 = () => i2.values([row]).returning(pick);
const a3 = () => i3.values(row).returning(pick);
const b3 = () => i3.values([row]).returning(pick);
const a4 = () => i4.values(row).returning(pick);
const b4 = () => i4.valuesMany([row]).returning(pick);
const a5 = () => i5.values(row).returning(pick);
const b5 = () => i5.valuesMany([row]).returning(pick);
const a6 = () => i6.values(row).returning(pick);
const b6 = () => i6.values([row]).returning(pick);
