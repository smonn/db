import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./timestamp-text.ts";
import { parseBytea, parseDate, parseTimestamp } from "./value-text.ts";

describe("parseDate", () => {
  it.each(["2024-02-29", "0044-03-15 BC", "10000-01-01", "infinity", "-infinity"])(
    "passes %s through",
    (text) => {
      expect(parseDate(text)).toBe(text);
    },
  );

  it.each(["x2024-02-29", "2024-02-29x", "2024-02-29 BCE", "04/03/2024", "--infinity"])(
    "refuses %s, naming it",
    (text) => {
      expect(() => parseDate(text)).toThrow(`Can't read date "${text}" as YYYY-MM-DD`);
    },
  );
});

describe("parseTimestamp", () => {
  it("reads a timestamp as UTC, and an offset as the instant it names", () => {
    expect(parseTimestamp("2024-02-29 12:34:56")).toStrictEqual(new Date("2024-02-29T12:34:56Z"));
    expect(parseTimestamp("2024-02-29 12:34:56+09:18:59")).toStrictEqual(
      new Date("2024-02-29T03:15:57Z"),
    );
    expect(parseTimestamp("2024-02-29 12:34:56-03:30")).toStrictEqual(
      new Date("2024-02-29T16:04:56Z"),
    );
  });

  it("keeps three digits of the fraction, padding a shorter one", () => {
    expect(parseTimestamp("2024-02-29 12:34:56.123456").getUTCMilliseconds()).toBe(123);
    expect(parseTimestamp("2024-02-29 12:34:56.5").getUTCMilliseconds()).toBe(500);
  });

  it("reads BC years", () => {
    expect(parseTimestamp("0044-03-15 12:00:00.5 BC")).toStrictEqual(
      new Date("-000043-03-15T12:00:00.500Z"),
    );
  });

  it.each([
    "x2024-02-29 12:34:56",
    "2024-02-29 12:34:56x",
    "2024-02-29 12:34:56 AD",
    "infinity",
    "275761-01-01 00:00:00",
  ])("refuses %s, naming it", (text) => {
    expect(() => parseTimestamp(text)).toThrow(`Can't read timestamp "${text}" as a Date`);
  });
});

describe("formatTimestamp", () => {
  it("writes the year of a CE date, padded to four digits", () => {
    expect(formatTimestamp(new Date("0099-01-02T03:04:05.006Z"))).toBe(
      "0099-01-02 03:04:05.006+00",
    );
  });

  it("writes year 0 as 1 BC and a negative year as its BC number", () => {
    expect(formatTimestamp(new Date("0000-06-01T00:00:00Z"))).toBe("0001-06-01 00:00:00.000+00 BC");
    expect(formatTimestamp(new Date("-000043-03-15T12:00:00.500Z"))).toBe(
      "0044-03-15 12:00:00.500+00 BC",
    );
  });
});

describe("parseBytea", () => {
  it("reads hex pairs as bytes, in order", () => {
    expect(parseBytea(String.raw`\x00ff1080`)).toStrictEqual(Uint8Array.of(0, 255, 16, 128));
    expect(parseBytea(String.raw`\x`)).toStrictEqual(new Uint8Array());
  });

  it("refuses text that isn't hex, naming it", () => {
    expect(() => parseBytea(String.raw`\001\002`)).toThrow(`Can't read bytea "\\001\\002" as hex`);
  });
});
