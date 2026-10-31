/**
 * Parsing and summary for `tsc-cost.ts`: reads the figures `tsc --extendedDiagnostics` prints,
 * takes medians over the runs of each tree, and formats the base-versus-head table.
 */

export type Sample = { types: number; instantiations: number; checkTime: number };

const typesPattern = /^Types:\s+(\d+)$/mu;
const instantiationsPattern = /^Instantiations:\s+(\d+)$/mu;
const checkTimePattern = /^Check time:\s+(\d+(?:\.\d+)?)s$/mu;

function figure(output: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(output);
  if (match?.[1] === undefined) {
    throw new Error(`tsc --extendedDiagnostics printed no "${label}" line:\n${output}`);
  }
  return Number(match[1]);
}

export function parseDiagnostics(output: string): Sample {
  return {
    types: figure(output, typesPattern, "Types"),
    instantiations: figure(output, instantiationsPattern, "Instantiations"),
    checkTime: figure(output, checkTimePattern, "Check time"),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : (high + (sorted[middle - 1] ?? 0)) / 2;
}

export function medianSample(samples: readonly Sample[]): Sample {
  return {
    types: median(samples.map((sample) => sample.types)),
    instantiations: median(samples.map((sample) => sample.instantiations)),
    checkTime: median(samples.map((sample) => sample.checkTime)),
  };
}

/** The percent change from `base` to `head`, with its sign; `n/a` when `base` is zero. */
export function percentChange(base: number, head: number): string {
  if (base === 0) return "n/a";
  const percent = ((head - base) / base) * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

const seconds = (value: number): string => `${value.toFixed(3)}s`;

type Row = readonly [string, string, string, string];

function row(label: string, base: number, head: number, show: (value: number) => string): Row {
  return [label, show(base), show(head), percentChange(base, head)];
}

/** A table of types, instantiations, and check time, each the median over the runs. */
export function formatTable(base: Sample, head: Sample): string {
  const header: Row = ["", "base", "head", "change"];
  const rows: Row[] = [
    header,
    row("types", base.types, head.types, String),
    row("instantiations", base.instantiations, head.instantiations, String),
    row("check time", base.checkTime, head.checkTime, seconds),
  ];
  const widths = header.map((_, column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0)),
  );
  return rows
    .map((cells) =>
      cells
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
