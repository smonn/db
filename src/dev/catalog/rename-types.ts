/** A table the Definition renames: `name` is its SQL name now, `was` the name it had. */
export type TableRename = {
  readonly kind: "table";
  readonly schema: string;
  readonly name: string;
  readonly was: string;
};

export type ColumnRename = {
  readonly kind: "column";
  readonly schema: string;
  /** The table's SQL name after the table renames, if it does. */
  readonly table: string;
  readonly name: string;
  readonly was: string;
};

export type EnumRename = {
  readonly kind: "enum";
  readonly schema: string;
  readonly name: string;
  readonly was: string;
};

export type LabelRename = {
  readonly kind: "enum label";
  readonly schema: string;
  /** The enum's SQL name after the enum renames, if it does. */
  readonly enum: string;
  readonly name: string;
  readonly was: string;
};

export type DomainRename = {
  readonly kind: "domain";
  readonly schema: string;
  readonly name: string;
  readonly was: string;
};

export type Rename = TableRename | ColumnRename | EnumRename | LabelRename | DomainRename;
