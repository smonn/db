import { sql as fragment } from "../sql/index.ts";
import { brand, type Query, type Statement } from "./from.ts";

/**
 * A whole hand-written statement, for what the builder can't express. Give the row type,
 * `` sql<Row>`select ...` ``, to read rows with `client.all` or `client.one`; without one it
 * is a Statement for `client.run`. Each interpolated value is bound as a param.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Statement;
export function sql<R>(strings: TemplateStringsArray, ...values: unknown[]): Query<R>;
export function sql<R>(strings: TemplateStringsArray, ...values: unknown[]): Query<R> {
  for (const [index, value] of values.entries()) {
    if (isStatement(value)) {
      throw new TypeError(`sql takes values, not statements: value ${index + 1} is a statement`);
    }
  }
  return brand<Query<R>>(fragment(strings, ...values));
}

function isStatement(value: unknown): boolean {
  return typeof value === "object" && value !== null && "toSql" in value;
}
