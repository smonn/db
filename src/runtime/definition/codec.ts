/**
 * Translates between a column's base value (ADR-0010) and the value the application wants. The
 * query layer runs `decode` on rows after the driver and `encode` on values before it; neither
 * ever sees NULL.
 */
export type Codec<Base, Value> = {
  decode(base: Base): Value;
  encode(value: Value): Base;
};

/** A Codec with its types erased, as the query layer runs it. */
export type RuntimeCodec = {
  decode(base: unknown): unknown;
  encode(value: unknown): unknown;
};
