import { quoteIdentifier } from "../../runtime/internal/index.ts";
import {
  childrenOf,
  parentOf,
  qualified,
  type Catalog,
  type DomainRename,
  type EnumRename,
  type LabelRename,
} from "../catalog/index.ts";
import { labelPosition, quoteLiteral } from "./enums.ts";
import { DOMAIN_SCAN_LOCK, type HazardKind } from "./hazards.ts";
import { renameSql } from "./rename-sql.ts";
import type { FactOf } from "./statements.ts";

type Catalogs = { readonly from: Catalog; readonly to: Catalog };

/** The shape of a step in `actions.ts`, which imports this module, so it can't import its type. */
type TypeStep<F, Carries = unknown> = {
  readonly render: (fact: F, catalogs: Catalogs, action: Carries) => string;
  readonly hazards: (action: { readonly fact: F }) => readonly HazardKind[];
};

/** The kind of fact each type action acts on. */
export type TypeTarget = {
  "create enum": "enum";
  "add enum value": "enum";
  "drop enum": "enum";
  "create domain": "domain";
  "alter domain default": "domain";
  "alter domain not null": "domain";
  "add domain check": "domain check";
  "drop domain check": "domain check";
  "drop domain": "domain";
  "rename enum": "enum";
  "rename enum label": "enum";
  "rename domain": "domain";
  "rename domain check": "domain check";
  "rename replaced type": "enum" | "domain";
  "drop replaced type": "enum" | "domain";
};

/** What a type action needs beyond its fact. */
export type TypeCarries = {
  /** The renamed type's fact is the `from` catalog's, which already holds the renamed type. */
  "rename enum": { readonly rename: EnumRename };
  "rename enum label": { readonly rename: LabelRename };
  "rename domain": { readonly rename: DomainRename };
  /** The check's name before the rename; its fact is the `to` catalog's. */
  "rename domain check": { readonly was: string };
  /** The name the old type takes while the table of its name is created, and drops under. */
  "rename replaced type": { readonly aside: string };
  "drop replaced type": { readonly aside: string };
};

const none = (): readonly HazardKind[] => [];
// Only the catalog changes, but raw casts and code writing the old name break until they deploy.
const renamed = (): readonly HazardKind[] => ["rename"];

function checkClause(check: FactOf<"domain check">): string {
  return `constraint ${quoteIdentifier(check.name)} check (${check.payload.expression})`;
}

/** Creates the domain whole, its checks included. */
function createDomain(domain: FactOf<"domain">, { to }: Catalogs): string {
  const { base, notNull, default: expression } = domain.payload;
  const parts = [`create domain ${qualified(domain, to)} as ${base}`];
  if (notNull) parts.push("not null");
  if (expression !== null) parts.push(`default (${expression})`);
  for (const child of childrenOf(to, domain)) {
    // Stryker disable next-line ConditionalExpression: a domain's children are all checks, so the kind test only narrows the type.
    if (child.kind === "domain check") parts.push(checkClause(child));
  }
  return `${parts.join(" ")};`;
}

function alterDomain(fact: FactOf<"domain" | "domain check">, catalog: Catalog): string {
  const domain = fact.kind === "domain" ? fact : parentOf(catalog, fact);
  return `alter domain ${qualified(domain, catalog)}`;
}

/**
 * The statements for an enum, a domain, and a domain's checks. Each only changes the catalog,
 * but `SET NOT NULL` and a new check scan every column of the domain (ADR-0023). Generate never
 * adds a check `NOT VALID` and validates it after, which in one transaction only adds a step.
 */
export const TYPE_STEPS: {
  readonly "create enum": TypeStep<FactOf<"enum">>;
  readonly "add enum value": TypeStep<
    FactOf<"enum">,
    { readonly before: FactOf<"enum">; readonly label: string }
  >;
  readonly "drop enum": TypeStep<FactOf<"enum">>;
  readonly "create domain": TypeStep<FactOf<"domain">>;
  readonly "alter domain default": TypeStep<FactOf<"domain">>;
  readonly "alter domain not null": TypeStep<FactOf<"domain">>;
  readonly "add domain check": TypeStep<FactOf<"domain check">>;
  readonly "drop domain check": TypeStep<FactOf<"domain check">>;
  readonly "drop domain": TypeStep<FactOf<"domain">>;
  readonly "rename enum": TypeStep<FactOf<"enum">, TypeCarries["rename enum"]>;
  readonly "rename enum label": TypeStep<FactOf<"enum">, TypeCarries["rename enum label"]>;
  readonly "rename domain": TypeStep<FactOf<"domain">, TypeCarries["rename domain"]>;
  readonly "rename domain check": TypeStep<
    FactOf<"domain check">,
    TypeCarries["rename domain check"]
  >;
  readonly "rename replaced type": TypeStep<
    FactOf<"enum" | "domain">,
    TypeCarries["rename replaced type"]
  >;
  readonly "drop replaced type": TypeStep<
    FactOf<"enum" | "domain">,
    TypeCarries["drop replaced type"]
  >;
} = {
  "create enum": {
    render: (type, { to }) =>
      `create type ${qualified(type, to)} as enum (${type.payload.labels.map(quoteLiteral).join(", ")});`,
    hazards: none,
  },
  // Adding a label rewrites no row. Using it in the same transaction fails (55P04), which
  // `explainShadowError` words.
  "add enum value": {
    render: (fact, { to }, { before, label }) =>
      `alter type ${qualified(fact, to)} add value ${quoteLiteral(label)}${labelPosition(fact, before, label)};`,
    hazards: none,
  },
  "drop enum": {
    render: (type, { from }) => `drop type ${qualified(type, from)};`,
    hazards: none,
  },
  "create domain": { render: createDomain, hazards: none },
  "alter domain default": {
    render: (domain, { to }) => {
      const expression = domain.payload.default;
      return `${alterDomain(domain, to)} ${expression === null ? "drop default" : `set default (${expression})`};`;
    },
    hazards: none,
  },
  "alter domain not null": {
    render: (domain, { to }) =>
      `${alterDomain(domain, to)} ${domain.payload.notNull ? "set" : "drop"} not null;`,
    hazards: ({ fact }) => (fact.payload.notNull ? DOMAIN_SCAN_LOCK : []),
  },
  "add domain check": {
    render: (check, { to }) => `${alterDomain(check, to)} add ${checkClause(check)};`,
    hazards: () => DOMAIN_SCAN_LOCK,
  },
  "drop domain check": {
    render: (check, { from }) =>
      `${alterDomain(check, from)} drop constraint ${quoteIdentifier(check.name)};`,
    hazards: none,
  },
  "drop domain": {
    render: (domain, { from }) => `drop domain ${qualified(domain, from)};`,
    hazards: none,
  },
  "rename enum": { render: (_type, _catalogs, { rename }) => renameSql(rename), hazards: renamed },
  "rename enum label": {
    render: (_type, _catalogs, { rename }) => renameSql(rename),
    hazards: renamed,
  },
  "rename domain": {
    render: (_domain, _catalogs, { rename }) => renameSql(rename),
    hazards: renamed,
  },
  // A constraint's name is no API, so like a table's constraint it renames with no Hazard.
  "rename domain check": {
    render: (check, { to }, { was }) =>
      `${alterDomain(check, to)} rename constraint ${quoteIdentifier(was)} to ${quoteIdentifier(check.name)};`,
    hazards: none,
  },
  // The old type only changes name while its columns move off it, so no app code sees it.
  "rename replaced type": {
    render: (type, { from }, { aside }) =>
      `alter type ${qualified(type, from)} rename to ${quoteIdentifier(aside)};`,
    hazards: none,
  },
  "drop replaced type": {
    render: (type, { from }, { aside }) =>
      `drop type ${quoteIdentifier(parentOf(from, type).name)}.${quoteIdentifier(aside)};`,
    hazards: none,
  },
};
