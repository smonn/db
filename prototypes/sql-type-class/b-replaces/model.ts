// Throwaway probe for #709, shape B: the SQL type class replaces `int` in #571's flags object.
// Types only: every value is declared, and no file here runs.

type Identity = "always" | "by default";
type Codec<From, To> = {
  readonly decode: (value: From) => To;
  readonly encode: (value: To) => From;
};
type Target<V> = { readonly "~types": { readonly value: V } };

/** `integer` is what may take an identity; `Comparable` lets it meet `decimal`. An array appends `[]`. */
export type ScalarClass =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "uuid"
  | "time"
  | "jsonb"
  | "bytea"
  | `enum:${string}`;

export type Flags = {
  readonly notNull: boolean;
  readonly sqlClass: string;
  readonly generated: boolean;
  readonly primaryKey: boolean;
  readonly key: boolean;
  readonly codec: boolean;
  readonly fk: boolean;
  readonly fresh: boolean;
};

export type Fresh<C extends string, N extends boolean = false> = {
  readonly notNull: N;
  readonly sqlClass: C;
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

type ArrayOf<F extends Flags> = With<
  Fresh<`${F["sqlClass"]}[]`>,
  { readonly codec: true; readonly fresh: false }
>;

export type Column<V, F extends Flags> = {
  readonly "~types": {
    readonly value: V;
    readonly notNull: F["notNull"];
    readonly generated: F["generated"];
    readonly primaryKey: F["primaryKey"];
    readonly key: F["key"];
    readonly sqlClass: F["sqlClass"];
  };
  notNull(): Column<V, With<F, { readonly notNull: true; readonly fresh: false }>>;
  name(sqlName: string): Column<V, F>;
  renamedFrom(oldName: string): Column<V, F>;
  index(): Column<V, F>;
} & (F["fresh"] extends true ? { array(): Column<(V | null)[], ArrayOf<F>> } : unknown) &
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
      } & (F["sqlClass"] extends "integer"
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

/**
 * The labels in order, comma-joined, so a subset of the labels makes a different class. Tail
 * recursive: the `${H},${Join<R>}` form fails with TS2589 from 48 labels.
 */
type Join<L extends readonly string[], Acc extends string = ""> = L extends readonly [
  infer H extends string,
  ...infer R extends readonly string[],
]
  ? R extends readonly []
    ? `${Acc}${H}`
    : Join<R, `${Acc}${H},`>
  : string;

export type Domain<V = unknown, N extends boolean = boolean, C extends string = string> = {
  readonly kind: "domain";
  readonly "~types": { readonly value: V; readonly notNull: N; readonly sqlClass: C };
};

export type ColumnFactories = {
  readonly text: <T extends string = string>() => Column<T, Fresh<"text">>;
  readonly varchar: <T extends string = string>(length: number) => Column<T, Fresh<"text">>;
  readonly smallint: () => Column<number, Fresh<"integer">>;
  readonly integer: () => Column<number, Fresh<"integer">>;
  readonly bigint: () => Column<bigint, Fresh<"integer">>;
  readonly numeric: (precision?: number, scale?: number) => Column<string, Fresh<"decimal">>;
  readonly real: () => Column<number, Fresh<"decimal">>;
  readonly doublePrecision: () => Column<number, Fresh<"decimal">>;
  readonly boolean: () => Column<boolean, Fresh<"boolean">>;
  readonly uuid: () => Column<string, Fresh<"uuid">>;
  readonly date: () => Column<string, Fresh<"time">>;
  readonly timestamp: () => Column<Date, Fresh<"time">>;
  readonly timestamptz: () => Column<Date, Fresh<"time">>;
  readonly jsonb: <T = unknown>() => Column<T, Fresh<"jsonb">>;
  readonly bytea: () => Column<Uint8Array, Fresh<"bytea">>;
  readonly enum: <L extends readonly string[]>(
    type: Enum<L>,
  ) => Column<L[number], Fresh<`enum:${Join<L>}`>>;
  /** A domain keeps its base's class, so a domain over integer offers `identity()` (a gap). */
  readonly domain: <V, N extends boolean, C extends string>(
    type: Domain<V, N, C>,
  ) => Column<V, Fresh<C, N>>;
};

export declare const c: ColumnFactories;

export declare function defineDomain<V, C extends string, N extends boolean = false>(
  define: (c: Omit<ColumnFactories, "domain">) => Column<V, Fresh<C>>,
  options?: { readonly notNull?: N },
): Domain<V, N, C>;

// The query side reads the class: a stand-in for #655's and #658's methods.

export type Predicate = { readonly "~predicate": true };

export type ColumnOperand<C extends string> = { readonly "~class": C };

/** The other classes Postgres compares a class with, beyond itself. */
type Comparisons = { readonly integer: "decimal"; readonly decimal: "integer" };

type Comparable<C extends string> = C | (C extends keyof Comparisons ? Comparisons[C] : never);

type ElementOf<V> = V extends readonly (infer E)[] ? E : never;

export type Ref<V, C extends string> = ColumnOperand<C> & {
  eq(operand: NonNullable<V> | ColumnOperand<Comparable<C>>): Predicate;
} & (C extends "text" ? { like(pattern: string): Predicate } : unknown) &
  (C extends `${string}[]` ? { includes(value: NonNullable<ElementOf<V>>): Predicate } : unknown);

type AnyColumn = { readonly "~types": { readonly value: unknown; readonly sqlClass: string } };

export declare function ref<Col extends AnyColumn>(
  column: Col,
): Ref<Col["~types"]["value"], Col["~types"]["sqlClass"]>;
