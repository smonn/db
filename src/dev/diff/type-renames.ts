import type { DomainRename, EnumRename, Fact, LabelRename } from "../catalog/index.ts";
import type { Action } from "./actions.ts";

/** The action for an enum, label, or domain rename, on the fact the `from` catalog holds. */
export function typeRenameAction(
  rename: EnumRename | LabelRename | DomainRename,
  fact: Fact,
): Action | undefined {
  if (rename.kind === "domain") {
    return fact.kind === "domain" ? { kind: "rename domain", fact, rename } : undefined;
  }
  return fact.kind === "enum" ? enumRenameAction(rename, fact) : undefined;
}

function enumRenameAction(
  rename: EnumRename | LabelRename,
  fact: Extract<Fact, { readonly kind: "enum" }>,
): Action {
  return rename.kind === "enum"
    ? { kind: "rename enum", fact, rename }
    : { kind: "rename enum label", fact, rename };
}
