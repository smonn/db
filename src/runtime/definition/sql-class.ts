/**
 * The groups of types Postgres compares or matches alike: `text` is text and varchar, `number` the
 * numeric types, `time` date, timestamp, and timestamptz. An enum is one class whatever its labels.
 */
export type ScalarClass =
  | "text"
  | "number"
  | "boolean"
  | "uuid"
  | "time"
  | "jsonb"
  | "bytea"
  | "enum";

/** A column's SQL type class: its base's, with `[]` after `.array()`. */
export type SqlClass = ScalarClass | `${ScalarClass}[]`;
