/** A result row as the driver returns it, untyped. A table's typed row is `Row<T>` in the definition module. */
export type DriverRow = Record<string, unknown>;

export type QueryResult = { rows: DriverRow[]; count: number };

export type Queryable = {
  /**
   * Runs one statement as a prepared statement, binding `params` to `$1`, `$2`, and so on.
   * `count` is the rows the statement returned or changed.
   */
  query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
  /** Runs a script of any number of statements without params, such as a Migration file. */
  execute(script: string): Promise<void>;
};

export type Session = Queryable & {
  /** Rolls back when `fn` rejects. Transactions don't nest. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

export type Driver = Session & {
  /**
   * Holds one connection for the whole of `fn`, as session advisory locks need. The locks are
   * released when `fn` settles, whether it resolves or rejects.
   */
  session<T>(fn: (session: Session) => Promise<T>): Promise<T>;
};

export type Connection = {
  readonly driver: Driver;
  close(): Promise<void>;
};

/** Opens a Driver on another database of the same server, such as a Shadow database. */
export type Connect = (database: string) => Promise<Connection>;
