import type { Queryable } from "../ports/index.ts";
import type { Query } from "./from.ts";

export type Client = {
  all<R>(query: Query<R>): Promise<R[]>;
};

/** Pass a transaction's `tx` to run statements inside that transaction. */
export function createClient(queryable: Queryable): Client {
  return {
    async all<R>(query: Query<R>): Promise<R[]> {
      const { text, params } = query.toSql();
      const rows = await queryable.query(text, params);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The query's row type describes what Postgres returns.
      return rows as R[];
    },
  };
}
