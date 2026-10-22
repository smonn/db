/** A Committed migration's name, such as `000001-create-users.sql`, capturing its sequence. */
export const COMMITTED_FILENAME: RegExp = /^(\d+)-[^/]+\.sql$/u;

/** The Current migration's name, beside the Committed migrations in the same folder. */
export const CURRENT_FILENAME = "current.sql";
