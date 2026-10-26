import type { Codec } from "./codec.ts";

/** The part of `Temporal.PlainDate` the codec relies on, so no Temporal lib or polyfill types are needed. */
export type PlainDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  toString(): string;
  equals(other: PlainDate): boolean;
};

type PlainDateConstructor = { from(text: string): PlainDate };

function plainDateConstructor(): PlainDateConstructor {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Temporal is read from globalThis when the codec runs, since Node 24 has none and a polyfill may install it later (ADR-0022).
  const temporal = (globalThis as { Temporal?: { PlainDate?: PlainDateConstructor } }).Temporal;
  if (temporal?.PlainDate === undefined) {
    throw new Error(
      "plainDate needs globalThis.Temporal, which this runtime does not have; install a Temporal polyfill first",
    );
  }
  return temporal.PlainDate;
}

/** Maps a `date` column to `Temporal.PlainDate`. Reads `globalThis.Temporal` on each use and throws when it is missing. */
export const plainDate: Codec<string, PlainDate> = {
  decode: (base) => plainDateConstructor().from(base),
  encode: (value) => value.toString(),
};
