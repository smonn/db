// PROTOTYPE, throwaway. Variant C stands in for `@smonn/db`: like A, but
// column factories arrive as a callback parameter, so a Definition file
// imports only table and schema (the ADR-0004 "no imports" idea).

import * as core from "../core.ts";
import { isTable, makeTable, type Columns, type Table, type TableOptions } from "../core.ts";

export type { Row, NewRow } from "../core.ts";

const factories = {
  text: core.text,
  varchar: core.varchar,
  smallint: core.smallint,
  integer: core.integer,
  bigint: core.bigint,
  numeric: core.numeric,
  real: core.real,
  doublePrecision: core.doublePrecision,
  boolean: core.boolean,
  uuid: core.uuid,
  date: core.date,
  timestamp: core.timestamp,
  timestamptz: core.timestamptz,
  jsonb: core.jsonb,
  bytea: core.bytea,
  sql: core.sql,
};

export type ColumnFactories = typeof factories;

export function table<C extends Columns>(
  name: string,
  define: (c: ColumnFactories) => C,
  options?: TableOptions<NoInfer<C>>,
): Table<C> {
  return makeTable("public", name, define(factories), options);
}

export function schema(schemaName: string) {
  return {
    table: <C extends Columns>(
      name: string,
      define: (c: ColumnFactories) => C,
      options?: TableOptions<NoInfer<C>>,
    ): Table<C> => makeTable(schemaName, name, define(factories), options),
  };
}

export function collectTables(module: Record<string, unknown>): Table[] {
  return Object.values(module).filter(isTable);
}
