import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, parentOf, qualified, type Catalog } from "../catalog/index.ts";
import { labelPosition, quoteLiteral } from "./enums.ts";
import { DOMAIN_SCAN_LOCK, type HazardKind } from "./hazards.ts";
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
};

const none = (): readonly HazardKind[] => [];

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
};
