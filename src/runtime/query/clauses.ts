import type { Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { isTextArray } from "./array-text.ts";
import { decoderFor, encodeValue, withDecoder, type Decode } from "./codecs.ts";
import { isExpr, isOrdering, type Expr } from "./expr.ts";
import {
  columnSql,
  refsOf,
  sourceOf,
  type ColumnSource,
  type Orderable,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import { brand, type Query } from "./statement.ts";

/** The parts of a statement that `from`, `insert`, `update`, and `deleteFrom` share. */

/** An output reads a column or an Expr. */
export type Output = readonly [alias: string, source: ColumnSource | Expr];

/** Whether `row` gives a value for `name`; an undefined value stands for none. */
export function has(row: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(row, name) && row[name] !== undefined;
}

/** An Expr inlines and runs no codec; any other value binds through the column's codec. */
export function cellOf(table: Table, name: string, value: unknown): Fragment {
  return isExpr(value) ? value["~expr"]() : fragment`${encodeValue(table, name, value)}`;
}

/** Throws for a key that is no column of `table`. */
export function assertColumns(table: Table, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(table.columns, key)) {
      throw new Error(`"${key}" is not a column of "${table.schema}"."${table.name}"`);
    }
  }
}

/** What renders one `orderBy` term; throws for a term that is no column, Expr, or ordering. */
export function sortKeyOf(term: Orderable, index: number): () => Fragment {
  if (isOrdering(term)) return () => term["~ordering"]();
  if (isExpr(term)) return () => term["~expr"]();
  const source = sourceOf(term);
  if (source === undefined) {
    throw new Error(`orderBy: term ${index + 1} is no column, Expr, or ordering`);
  }
  return () => columnSql(source);
}

/** The outputs of a `select` or `returning` callback's result, in its key order. */
export function outputsOf(clause: "select" | "returning", selection: Selection): Output[] {
  return Object.entries(selection).map(([alias, value]): Output => {
    if (isExpr(value)) return [alias, value];
    const source = sourceOf(value);
    if (source === undefined) throw new Error(`${clause}: "${alias}" is no column or Expr`);
    return [alias, source];
  });
}

/** Decodes each column output through its own table's codecs; an Expr's value runs no codec. */
export function decodeOutputs(outputs: readonly Output[]): Decode | undefined {
  const byTable = new Map<Table, (readonly [alias: string, column: string])[]>();
  for (const [alias, source] of outputs) {
    if (isExpr(source)) continue;
    const columns = byTable.get(source.table) ?? [];
    columns.push([alias, source.key]);
    byTable.set(source.table, columns);
  }
  const steps = [...byTable].flatMap(([table, columns]) => decoderFor(table, columns) ?? []);
  if (steps.length <= 1) return steps[0];
  return (row) => steps.reduce((next, step) => step(next), row);
}

/**
 * An output aliases its column back to the key the row type names, unless the two are one. An
 * enum or domain array is cast to text, which `decoderFor` reads: its OID differs per database, so
 * the driver can't be relied on to parse it (ADR-0023). An Expr always takes its alias.
 */
export function renderOutput([alias, source]: Output): Fragment {
  if (isExpr(source)) return fragment`${source["~expr"]()} as ${identifier(alias)}`;
  const { table, key } = source;
  const name = table.columnNames[key] ?? key;
  const column = table.columns[key];
  const sql = columnSql(source);
  if (column === undefined || !isTextArray(column)) {
    return alias === name ? sql : fragment`${sql} as ${identifier(alias)}`;
  }
  return fragment`${sql}::text as ${identifier(alias)}`;
}

/** Appends `returning` to the statement `body` builds, and decodes each row the picked columns return. */
export function returning<R, S extends Selection>(
  table: Table,
  pick: (columns: Refs<R>) => S,
  body: () => Fragment,
): Query<Selected<S>> {
  const outputs = outputsOf("returning", pick(refsOf(table)));
  if (outputs.length === 0) throw new Error("returning needs at least one column");
  return withDecoder(
    brand<Query<Selected<S>>>({
      toSql() {
        const list = join(
          outputs.map((output) => renderOutput(output)),
          fragment`, `,
        );
        return fragment`${body()} returning ${list}`.toSql();
      },
    }),
    decodeOutputs(outputs),
  );
}
