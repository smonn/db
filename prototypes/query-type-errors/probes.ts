// PROTOTYPE for #656: every call below is wrong on purpose; report.ts prints each one's error.
import type { Users } from "./core.ts";
import type { db } from "./core.ts";
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

declare const s5: S5<Users>;
declare const s6: S6<Users>;
declare const i7: I7<Users>;
declare const w7: I7<typeof db.public.wide>;
declare const i8: I8<Users>;
declare const i9: I9<Users>;

declare const s0: S0<Users>;
declare const s1: S1<Users>;
declare const s2: S2<Users>;
declare const s3: S3<Users>;
declare const s4: S4<Users>;
declare const i0: I0<Users>;
declare const i1: I1<Users>;
declare const i2: I2<Users>;
declare const i3: I3<Users>;
declare const i4: I4<Users>;
declare const i5: I5<Users>;
declare const i6: I6<Users>;
declare const w0: I0<typeof db.public.wide>;
declare const w5: I5<typeof db.public.wide>;

export const probes = [
  // case: S0 callback-wrong-key
  s0.select((u) => ({ x: u.nope })),
  // case: S1 name-list-wrong-name
  s1.select("id", "nope"),
  // case: S1 callback-wrong-key
  s1.select((u) => ({ x: u.nope })),
  // case: S2 name-list-wrong-name
  s2.select("id", "nope"),
  // case: S2 callback-wrong-key
  s2.select((u) => ({ x: u.nope })),
  // case: S3 name-list-wrong-name
  s3.select("id", "nope"),
  // case: S3 callback-wrong-key
  s3.select((u) => ({ x: u.nope })),
  // case: S4 name-list-wrong-name
  s4.pick("id", "nope"),
  // case: S4 callback-wrong-key
  s4.select((u) => ({ x: u.nope })),

  // case: I0 wrong-key
  i0.values({ id: "u1", nope: "x" }),
  // case: I0 missing-required
  i0.values({ email: "x" }),
  // case: I0 wrong-type
  i0.values({ id: 1 }),
  // case: I0 rows-wrong-key
  i0.values([{ id: "u1" }, { id: "u2", nope: "x" }]),
  // case: I0 wide-wrong-key
  w0.values({ id: "u1", nope: "x" }),

  // case: I1 wrong-key
  i1.values({ id: "u1", nope: "x" }),
  // case: I1 missing-required
  i1.values({ email: "x" }),
  // case: I1 wrong-type
  i1.values({ id: 1 }),
  // case: I1 rows-wrong-key
  i1.values([{ id: "u1" }, { id: "u2", nope: "x" }]),

  // case: I2 wrong-key
  i2.values({ id: "u1", nope: "x" }),
  // case: I2 missing-required
  i2.values({ email: "x" }),
  // case: I2 wrong-type
  i2.values({ id: 1 }),
  // case: I2 rows-wrong-key
  i2.values([{ id: "u1" }, { id: "u2", nope: "x" }]),

  // case: I3 wrong-key
  i3.values({ id: "u1", nope: "x" }),
  // case: I3 missing-required
  i3.values({ email: "x" }),
  // case: I3 wrong-type
  i3.values({ id: 1 }),
  // case: I3 rows-wrong-key
  i3.values([{ id: "u1" }, { id: "u2", nope: "x" }]),

  // case: I4 wrong-key
  i4.values({ id: "u1", nope: "x" }),
  // case: I4 missing-required
  i4.values({ email: "x" }),
  // case: I4 wrong-type
  i4.values({ id: 1 }),
  // case: I4 rows-wrong-key
  i4.valuesMany([{ id: "u1" }, { id: "u2", nope: "x" }]),

  // case: I5 wrong-key
  i5.values({ id: "u1", nope: "x" }),
  // case: I5 missing-required
  i5.values({ email: "x" }),
  // case: I5 wrong-type
  i5.values({ id: 1 }),
  // case: I5 rows-wrong-key
  i5.valuesMany([{ id: "u1" }, { id: "u2", nope: "x" }]),
  // case: I5 wide-wrong-key
  w5.values({ id: "u1", nope: "x" }),

  // case: S5 name-list-wrong-name
  s5.select("id", "nope"),
  // case: S5 single-wrong-name
  s5.select("nope"),
  // case: S1 single-wrong-name
  s1.select("nope"),
  // case: S2 single-wrong-name
  s2.select("nope"),
  // case: S6 name-list-wrong-name
  s6.select("id", "nope"),
  // case: S6 single-wrong-name
  s6.select("nope"),
  // case: S6 callback-wrong-key
  s6.select((u) => ({ x: u.nope })),
  // case: S6 callback-not-a-column
  s6.select(() => ({ x: 1 })),
  // case: S0 callback-not-a-column
  s0.select(() => ({ x: 1 })),
  // case: S5 callback-not-a-column
  s5.select(() => ({ x: 1 })),
  // case: S5 callback-wrong-key
  s5.select((u) => ({ x: u.nope })),

  // case: I7 wrong-key
  i7.values({ id: "u1", nope: "x" }),
  // case: I7 missing-required
  i7.values({ email: "x" }),
  // case: I7 wrong-type
  i7.values({ id: 1 }),
  // case: I7 rows-wrong-key
  i7.values([{ id: "u1" }, { id: "u2", nope: "x" }]),
  // case: I7 wide-wrong-key
  w7.values({ id: "u1", nope: "x" }),

  // case: I8 wrong-key
  i8.values({ id: "u1", nope: "x" }),
  // case: I8 missing-required
  i8.values({ email: "x" }),
  // case: I8 wrong-type
  i8.values({ id: 1 }),
  // case: I8 rows-wrong-key
  i8.valuesMany([{ id: "u1" }, { id: "u2", nope: "x" }]),

  // case: I9 wrong-key
  i9.values({ id: "u1", nope: "x" }),
  // case: I9 missing-required
  i9.values({ email: "x" }),
  // case: I9 wrong-type
  i9.values({ id: 1 }),
  // case: I9 rows-wrong-key
  i9.values({ id: "u1" }, { id: "u2", nope: "x" }),
  // case: I9 rows-missing-required
  i9.values({ id: "u1" }, { email: "x" }),

  // case: I6 wrong-key
  i6.values({ id: "u1", nope: "x" }),
  // case: I6 missing-required
  i6.values({ email: "x" }),
  // case: I6 wrong-type
  i6.values({ id: 1 }),
  // case: I6 rows-wrong-key
  i6.values([{ id: "u1" }, { id: "u2", nope: "x" }]),
];
