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
  /**
   * Rolls back when `fn` rejects. If the rollback fails too, rejects with an AggregateError of
   * both. Transactions don't nest.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

export type Driver = Session & {
  /**
   * Holds one connection for the whole of `fn`, as session advisory locks need. When `fn`
   * settles, the session rolls back any transaction `fn` left and resets its settings, temp
   * tables, and locks, so the next user of the connection starts clean. If the reset fails, the
   * connection closes instead. If it can't close either, it goes back to the pool unreset and the
   * session rejects with the reset's error. A rejecting `fn` rejects the session with its own
   * error, or with an AggregateError of both when the connection went back unreset. When `fn`
   * rejects because the connection was lost, the session sends nothing more and rejects with
   * that error. The reset keeps statements made with SQL `prepare`, since dropping them would
   * drop the driver's cached statements too. A pool kept open after such a failure may give that
   * connection's next query a stale 57P01 until postgres.js fixes
   * https://github.com/porsager/postgres/issues/1226.
   */
  session<T>(fn: (session: Session) => Promise<T>): Promise<T>;
};

export type Connection = {
  readonly driver: Driver;
  close(): Promise<void>;
};

/** Opens a Driver on another database of the same server, such as a Shadow database. */
export type Connect = (database: string) => Promise<Connection>;
