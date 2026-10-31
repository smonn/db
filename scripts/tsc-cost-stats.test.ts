import { describe, expect, test } from "vitest";
import {
  formatTable,
  median,
  medianSample,
  parseDiagnostics,
  percentChange,
} from "./tsc-cost-stats.ts";

const output = `Files:              808
Types:           182650
Instantiations:  393467
Memory used:    350407K
Check time:      0.212s
Total time:      0.281s
`;

describe("parseDiagnostics", () => {
  test("reads types, instantiations, and check time", () => {
    expect(parseDiagnostics(output)).toEqual({
      types: 182650,
      instantiations: 393467,
      checkTime: 0.212,
    });
  });

  test("reads a check time without a fraction", () => {
    expect(parseDiagnostics(output.replace("0.212s", "2s")).checkTime).toBe(2);
  });

  test.each([
    ["Types", "Types:           182650\n"],
    ["Instantiations", "Instantiations:  393467\n"],
    ["Check time", "Check time:      0.212s\n"],
  ])("names the missing %s line", (label, line) => {
    expect(() => parseDiagnostics(output.replace(line, ""))).toThrow(`printed no "${label}" line`);
  });

  test("ignores a figure that is not the whole line", () => {
    expect(() => parseDiagnostics(output.replace("Types:  ", "Total Types:  "))).toThrow(
      'no "Types" line',
    );
  });
});

describe("median", () => {
  test("takes the middle of an unsorted odd count", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  test("averages the middle two of an even count", () => {
    expect(median([4, 1, 3, 10])).toBe(3.5);
  });

  test("sorts numerically, not as text", () => {
    expect(median([10, 9, 100])).toBe(10);
  });

  test("leaves its input in order", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  test("rejects no values", () => {
    expect(() => median([])).toThrow("median of no values");
  });
});

describe("medianSample", () => {
  test("takes the median of each figure on its own", () => {
    expect(
      medianSample([
        { types: 3, instantiations: 30, checkTime: 0.3 },
        { types: 1, instantiations: 20, checkTime: 0.9 },
        { types: 2, instantiations: 10, checkTime: 0.1 },
      ]),
    ).toEqual({ types: 2, instantiations: 20, checkTime: 0.3 });
  });
});

describe("percentChange", () => {
  test.each([
    [100, 150, "+50.0%"],
    [200, 150, "-25.0%"],
    [100, 100, "0.0%"],
    [3, 4, "+33.3%"],
    [0, 5, "n/a"],
    [0, 0, "n/a"],
  ])("from %d to %d is %s", (base, head, expected) => {
    expect(percentChange(base, head)).toBe(expected);
  });
});

describe("formatTable", () => {
  test("aligns base, head, and change under their headings", () => {
    expect(
      formatTable(
        { types: 182650, instantiations: 393467, checkTime: 0.2 },
        { types: 182838, instantiations: 400000, checkTime: 0.25 },
      ),
    ).toBe(
      [
        "                  base    head  change",
        "types           182650  182838   +0.1%",
        "instantiations  393467  400000   +1.7%",
        "check time      0.200s  0.250s  +25.0%",
      ].join("\n"),
    );
  });
});
