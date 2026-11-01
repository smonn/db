import type { Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { isTextArray } from "./array-text.ts";
import { decoderFor, encodeValue, withDecoder, type Decode } from "./codecs.ts";
import { isExpr, type Expr } from "./expr.ts";
import {
  columnIdentifier,
  columnSql,
  refsOf,
  refSql,
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

/** The `order by` list of `terms`, in the order given. */
export function renderOrderBy(table: Table, terms: readonly Orderable[]): Fragment {
  return join(
    terms.map((term) => {
      if ("~ordering" in term) return term["~ordering"]();
      if (isExpr(term)) return term["~expr"]();
      return refSql(term) ?? columnIdentifier(table, term.name);
    }),
    fragment`, `,
  );
}

/** The outputs of a `select` or `returning` callback's result, in its key order. */
export function outputsOf(table: Table, selection: Selection): Output[] {
  return Object.entries(selection).map(([alias, value]): Output => [
    alias,
    isExpr(value) ? value : (sourceOf(value) ?? { table, key: value.name, alias: table.name }),
  ]);
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
  const outputs = outputsOf(table, pick(refsOf(table)));
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
