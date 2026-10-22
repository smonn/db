export type Row = Record<string, unknown>;

export type Queryable = {
  /** Runs one statement as a prepared statement, binding `params` to `$1`, `$2`, and so on. */
  query(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs one statement as `query` does and reports how many rows it returned or changed. */
  run(text: string, params?: readonly unknown[]): Promise<{ count: number }>;
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
