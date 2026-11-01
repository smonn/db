import { fragment } from "../sql/index.ts";
import { isExpr, writtenExpr, type Expr } from "./expr.ts";
import { refSql } from "./refs.ts";
import { brand, statementKind, type Query, type Statement } from "./statement.ts";

type Sql = {
  /**
   * A whole hand-written statement, for what the builder can't express. Give the row type,
   * `` sql<Row>`select ...` ``, to read rows with `client.all` or `client.one`; without one it
   * is a Statement for `client.run`. Each interpolated value is bound as a param.
   *
   * The postgres.js driver binds a `Date`, or an array of them, without a type, so Postgres takes
   * the type from the other side of the comparison or assignment. That fits a column or an
   * `= any(${dates})` list. Where nothing names a type, write the cast: `${at} - interval '1 hour'`
   * fails, `${at}::timestamptz - interval '1 hour'` works, and `select ${at}` returns UTC text.
   * Each use of a repeated `$n` is typed on its own, so `$n + interval` needs a cast on every use.
   */
  (strings: TemplateStringsArray, ...values: unknown[]): Statement;
  <R>(strings: TemplateStringsArray, ...values: unknown[]): Query<R>;
  /**
   * An expression of type `V` for `where`, `select`, `returning`, `orderBy`, `values`, and `set`. A
   * column ref renders as its column, an Expr inlines in parentheses, and any other value binds
   * as a param, with no codec. A statement inside one is refused, so it holds no subquery.
   */
  expr<V = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Expr<V>;
};

function refuseStatements(tag: string, values: readonly unknown[]): void {
  for (const [index, value] of values.entries()) {
    const kind = statementKind(value);
    if (kind !== undefined) {
      throw new TypeError(`${tag} takes values, not statements: value ${index + 1} is ${kind}`);
    }
    if (containsStatement(value)) {
      throw new TypeError(
        `${tag} takes values, not statements: value ${index + 1} contains a statement`,
      );
    }
  }
}

function containsStatement(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => statementKind(item) !== undefined || containsStatement(item))
  );
}

function statement<R>(strings: TemplateStringsArray, ...values: unknown[]): Query<R> {
  refuseStatements("sql", values);
  return brand<Query<R>>(fragment(strings, ...values));
}

function expr<V = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Expr<V> {
  refuseStatements("sql.expr", values);
  return writtenExpr<V>(() =>
    fragment(
      strings,
      ...values.map((value) => {
        if (isExpr(value)) return fragment`(${value["~expr"]()})`;
        return refSql(value) ?? value;
      }),
    ),
  );
}

// It mutates only `statement`, which nothing else holds, so a bundler may drop an unused `sql`.
// oxlint-disable-next-line eslint/no-inline-comments -- A bundler reads the annotation only inline.
export const sql: Sql = /* @__PURE__ */ Object.assign(statement, { expr });
