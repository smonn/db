import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineDatabase, defineEnum, defineTable, type Codec } from "../definition/index.ts";
import { decoderFor, encodeValue } from "./codecs.ts";

const times = (factor: number) => vi.fn<(n: number) => number>((n) => n * factor);

const encodeScalar = times(2);
const decodeScalar = times(3);
const scalar: Codec<number, number> = { encode: encodeScalar, decode: decodeScalar };

const encodeWhole = vi.fn<(value: unknown) => unknown>((value) => value);
const decodeWhole = vi.fn<(value: unknown) => unknown>((value) => value);
const whole: Codec<unknown, unknown> = { encode: encodeWhole, decode: decodeWhole };

const shade = defineEnum(["light", "dark"] as const);
const db = defineDatabase({
  public: {
    shade,
    t: defineTable((c) => ({
      one: c.integer().codec(scalar),
      many: c.integer().codec(scalar).array(),
      doc: c.jsonb().codec(whole),
      plainDoc: c.jsonb(),
      plain: c.integer(),
      shades: c.enum(shade).array(),
    })),
  },
});
const t = db.public.t;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("encodeValue", () => {
  it("runs a codec on a scalar column", () => {
    expect(encodeValue(t, "one", 4)).toBe(8);
  });

  it("passes a missing value and an unknown column through without a codec call", () => {
    expect(encodeValue(t, "one", null)).toBeNull();
    expect(encodeValue(t, "one", undefined)).toBeUndefined();
    expect(encodeValue(t, "missing", 5)).toBe(5);
    expect(encodeScalar).not.toHaveBeenCalled();
  });

  it("runs the codec on the whole array of a json column, not on its elements", () => {
    expect(encodeValue(t, "doc", [1, 2])).toStrictEqual([1, 2]);
    expect(encodeWhole).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it("sends an array value of a column that isn't an array column as it is", () => {
    expect(encodeValue(t, "plainDoc", [1, 2])).toStrictEqual([1, 2]);
    expect(encodeValue(t, "plain", [1, 2])).toStrictEqual([1, 2]);
  });

  it("runs the codec on each element of an array column and writes array text", () => {
    expect(encodeValue(t, "many", [1, null, 3])).toBe('{"2",NULL,"6"}');
    expect(encodeScalar).toHaveBeenCalledTimes(2);
  });

  it("runs the codec on a value of an array column that isn't an array", () => {
    expect(encodeValue(t, "many", 5)).toBe(10);
  });

  it("refuses an undefined element without running the codec on it", () => {
    const error = thrown(() => encodeValue(t, "many", [1, undefined]));
    expect(error).toMatchObject({
      message: 'Can\'t write the array in column "many" of "public"."t"',
      cause: { message: "An array element is undefined" },
    });
    expect(encodeScalar).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("decoderFor", () => {
  it("decodes the aliased outputs that have a codec, and nothing else in the row", () => {
    const decode = decoderFor(t, [
      ["a", "plain"],
      ["b", "one"],
    ]);
    expect(decode?.({ a: 1, b: 2, c: 3 })).toStrictEqual({ a: 1, b: 6, c: 3 });
  });

  it("skips a NULL or absent output without running the codec", () => {
    const decode = decoderFor(t, [["b", "one"]]);
    expect(decode?.({ b: null })).toStrictEqual({ b: null });
    expect(decode?.({ c: 1 })).toStrictEqual({ c: 1 });
    expect(decodeScalar).not.toHaveBeenCalled();
  });

  it("runs the codec on each element of an array output, skipping NULL elements", () => {
    const decode = decoderFor(t, [["m", "many"]]);
    expect(decode?.({ m: [1, null, 2] })).toStrictEqual({ m: [3, null, 6] });
  });

  it("runs the codec on the whole array of a json output", () => {
    const decode = decoderFor(t, [["d", "doc"]]);
    expect(decode?.({ d: [1, 2] })).toStrictEqual({ d: [1, 2] });
    expect(decodeWhole).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it("decodes nothing for outputs without a codec or a column", () => {
    expect(decoderFor(t, [])).toBeUndefined();
    expect(decoderFor(t, [["a", "plain"]])).toBeUndefined();
    expect(decoderFor(t, [["x", "missing"]])).toBeUndefined();
  });

  it("reads an enum array from text", () => {
    const decode = decoderFor(t, [["s", "shades"]]);
    expect(decode?.({ s: "{light,NULL,dark}" })).toStrictEqual({ s: ["light", null, "dark"] });
  });

  it("leaves an enum array that is not text as it is", () => {
    const decode = decoderFor(t, [["s", "shades"]]);
    expect(decode?.({ s: ["light"] })).toStrictEqual({ s: ["light"] });
  });

  it("names the column of an enum array it can't read", () => {
    const decode = decoderFor(t, [["s", "shades"]]);
    expect(thrown(() => decode?.({ s: "{light" }))).toMatchObject({
      message: 'Can\'t read the array in column "shades" of "public"."t"',
      cause: { message: 'Can\'t read array "{light"' },
    });
  });
});
