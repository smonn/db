import type { Queryable } from "../ports/index.ts";
import { decoderOf } from "./codecs.ts";
import type { Query, Statement } from "./from.ts";

export type Client = {
  all<R>(query: Query<R>): Promise<R[]>;
  /** Rejects unless the query returns exactly one row. */
  one<R>(query: Query<R> & { readonly "~many"?: never; readonly "~maybe"?: never }): Promise<R>;
  /** Runs any statement and reports how many rows it returned or changed. */
  run(statement: Statement): Promise<{ count: number }>;
};

/** Pass a transaction's `tx` to run statements inside that transaction. */
export function createClient(queryable: Queryable): Client {
  async function all<R>(query: Query<R>): Promise<R[]> {
    const { text, params } = query.toSql();
    const { rows } = await queryable.query(text, params);
    const decode = decoderOf(query);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The query's row type describes what Postgres returns, decoded by its codecs.
    return (decode === undefined ? rows : rows.map((row) => decode(row))) as R[];
  }

  return {
    all,
    async one<R>(
      query: Query<R> & { readonly "~many"?: never; readonly "~maybe"?: never },
    ): Promise<R> {
      const rows = await all(query);
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row === undefined) {
        throw new Error(`Expected one row but the query returned ${rows.length}`);
      }
      return row;
    },
    async run(statement) {
      const { text, params } = statement.toSql();
      const { count } = await queryable.query(text, params);
      return { count };
    },
  };
}
