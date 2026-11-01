// Throwaway probe for #709, cost baseline: #571's flags object with `int` and no SQL type class.
// Column operands match by TypeScript value type, the rule #658 decided before alternative D.
// Types only: every value is declared, and no file here runs.

type Identity = "always" | "by default";
type Codec<From, To> = {
  readonly decode: (value: From) => To;
  readonly encode: (value: To) => From;
};
type Target<V> = { readonly "~types": { readonly value: V } };

export type Flags = {
  readonly notNull: boolean;
  readonly int: boolean;
  readonly generated: boolean;
  readonly primaryKey: boolean;
  readonly key: boolean;
  readonly codec: boolean;
  readonly fk: boolean;
  readonly fresh: boolean;
};

export type Fresh<Int extends boolean = false, N extends boolean = false> = {
  readonly notNull: N;
  readonly int: Int;
  readonly generated: false;
  readonly primaryKey: false;
  readonly key: false;
  readonly codec: false;
  readonly fk: false;
  readonly fresh: true;
};

type With<F extends Flags, P extends Partial<Flags>> = {
  readonly [K in keyof Flags]: K extends keyof P ? P[K] : F[K];
};

type ArrayOf = With<Fresh, { readonly codec: true; readonly fresh: false }>;

export type Column<V, F extends Flags> = {
  readonly "~types": {
    readonly value: V;
    readonly notNull: F["notNull"];
    readonly generated: F["generated"];
    readonly primaryKey: F["primaryKey"];
    readonly key: F["key"];
  };
  notNull(): Column<V, With<F, { readonly notNull: true; readonly fresh: false }>>;
  name(sqlName: string): Column<V, F>;
  renamedFrom(oldName: string): Column<V, F>;
  index(): Column<V, F>;
} & (F["fresh"] extends true ? { array(): Column<(V | null)[], ArrayOf> } : unknown) &
  (F["codec"] extends true
    ? unknown
    : { codec<W>(codec: Codec<V, W>): Column<W, With<F, { readonly codec: true }>> }) &
  (F["key"] extends true
    ? unknown
    : {
        primaryKey(): Column<
          V,
          With<
            F,
            {
              readonly notNull: true;
              readonly primaryKey: true;
              readonly key: true;
              readonly fresh: false;
            }
          >
        >;
        unique(): Column<V, With<F, { readonly key: true; readonly fresh: false }>>;
      }) &
  (F["fk"] extends true
    ? unknown
    : {
        references(
          target: () => Target<V>,
        ): Column<V, With<F, { readonly fk: true; readonly fresh: false }>>;
      }) &
  (F["generated"] extends true
    ? unknown
    : {
        default(
          expression: string,
        ): Column<V, With<F, { readonly generated: true; readonly fresh: false }>>;
      } & (F["int"] extends true
        ? {
            identity(
              generated?: Identity,
            ): Column<
              V,
              With<F, { readonly notNull: true; readonly generated: true; readonly fresh: false }>
            >;
          }
        : unknown));

export type Enum<L extends readonly string[] = readonly string[]> = {
  readonly kind: "enum";
  readonly labels: L;
};

export declare function defineEnum<const L extends readonly string[]>(labels: L): Enum<L>;

export type Domain<V = unknown, N extends boolean = boolean> = {
  readonly kind: "domain";
  readonly "~types": { readonly value: V; readonly notNull: N };
};

export type ColumnFactories = {
  readonly text: <T extends string = string>() => Column<T, Fresh>;
  readonly varchar: <T extends string = string>(length: number) => Column<T, Fresh>;
  readonly smallint: () => Column<number, Fresh<true>>;
  readonly integer: () => Column<number, Fresh<true>>;
  readonly bigint: () => Column<bigint, Fresh<true>>;
  readonly numeric: (precision?: number, scale?: number) => Column<string, Fresh>;
  readonly real: () => Column<number, Fresh>;
  readonly doublePrecision: () => Column<number, Fresh>;
  readonly boolean: () => Column<boolean, Fresh>;
  readonly uuid: () => Column<string, Fresh>;
  readonly date: () => Column<string, Fresh>;
  readonly timestamp: () => Column<Date, Fresh>;
  readonly timestamptz: () => Column<Date, Fresh>;
  readonly jsonb: <T = unknown>() => Column<T, Fresh>;
  readonly bytea: () => Column<Uint8Array, Fresh>;
  readonly enum: <L extends readonly string[]>(type: Enum<L>) => Column<L[number], Fresh>;
  readonly domain: <V, N extends boolean>(type: Domain<V, N>) => Column<V, Fresh<false, N>>;
};

export declare const c: ColumnFactories;

export declare function defineDomain<V, Int extends boolean, N extends boolean = false>(
  define: (c: Omit<ColumnFactories, "domain">) => Column<V, Fresh<Int>>,
  options?: { readonly notNull?: N },
): Domain<V, N>;

export type Predicate = { readonly "~predicate": true };

export type ColumnOperand<V> = { readonly "~value": V };

export type Ref<V> = ColumnOperand<V> & {
  eq(operand: NonNullable<V> | ColumnOperand<NonNullable<V>>): Predicate;
};

type AnyColumn = { readonly "~types": { readonly value: unknown } };

export declare function ref<Col extends AnyColumn>(column: Col): Ref<Col["~types"]["value"]>;
