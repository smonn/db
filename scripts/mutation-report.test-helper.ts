type Mutant = { mutatorName: string; status: string; line: number };

export const expecting = (count: number, mutators = "StringLiteral"): string =>
  `  // Stryker expect next-line ${mutators}: ${count} survivor${count === 1 ? "" : "s"}: never shown`;
export const marker: string = expecting(1);

export function report(mutants: Mutant[], source: string[]): unknown {
  return {
    files: {
      "src/a.ts": {
        language: "typescript",
        source: source.join("\n"),
        mutants: mutants.map(({ mutatorName, status, line }) => ({
          mutatorName,
          status,
          location: { start: { line, column: 1 }, end: { line, column: 9 } },
        })),
      },
    },
  };
}
