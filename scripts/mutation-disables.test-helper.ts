import { describeDisables } from "./mutation-disables.ts";

/** A disable in a source file that holds one mutant line, marked as `mark-stryker-disables.ts` leaves it. */
export const marked =
  "// Stryker expect next-line StringLiteral: 1 survivor: never shown\nf('x');\n";

export type Mutant = { mutatorName: string; status: string; line: number };

export const mutant = (mutatorName: string, status: string, line = 2): Mutant => ({
  mutatorName,
  status,
  line,
});

export const reportOf = (files: Record<string, { source: string; mutants: Mutant[] }>): string =>
  JSON.stringify({
    files: Object.fromEntries(
      Object.entries(files).map(([file, { source, mutants }]) => [
        file,
        { source, mutants: mutants.map((m) => ({ ...m, location: { start: { line: m.line } } })) },
      ]),
    ),
  });

export const describeOne = (mutants: Mutant[], source: string = marked): string[] =>
  describeDisables(JSON.parse(reportOf({ "a.ts": { source, mutants } })));
