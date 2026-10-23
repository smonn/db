# Coding standards

Judgement rules that no check can enforce. Implementation agents follow them while writing code, and `review` checks every change against them. A rule a check can express belongs in that check instead (see AGENTS.md, Repo tooling), so treat every rule here as a candidate for one, and move it out once a check covers it. Each rule cites the change that earned it; add a rule when a review catches a judgement mistake, and drop one that stops earning its place.

## Design

- **Code follows accepted ADRs.** When code and an accepted ADR disagree, change the code, or stop and flag the conflict to the maintainer. An ADR changes only through the process in `docs/adr/TEMPLATE.md`. (#106 rewrote ADR-0004 to match its code.)

## Types

- **Make misuse a compile error when the type can express it.** A method that is never valid on a value is absent from its type, such as `isNull()` on a NOT NULL column. (#106; `smonn/required-brand` in `scripts/lint-plugin.ts` checks that `~` brands on exported types are required.)

## Input

- **Reject unknown input by name.** An unknown key, an empty selection, or a misnamed file throws an error naming it, rather than being dropped or skipped. (#105 dropped unknown row keys; #109 kept a misnamed migration file throwing.)

## Destructive paths

- **A destructive path checks, then acts, by itself.** Code that drops, resets, overwrites, or freezes the user's data proves it owns the target and runs every refusal from required inputs, not a hook the caller may skip. Each refusal names its reason and has a test. (#109's reset guard; #240's Hazard gate.)

## SQL

- **Quote identifiers, bind values, in SQL built before the call.** `smonn/sql-interpolation` checks a template literal passed straight to `query`, `unsafe`, or `execute`. SQL text built earlier, such as `MIGRATIONS_TABLE(schema)`, quotes every identifier with `quoteIdentifier` and passes every value as a bound parameter. (#104, #109)
- **Messages name identifiers the way SQL does.** An error that names a database object quotes and qualifies it (`"public"."users.archive"`), because a dotted, unquoted name can spell two objects. `smonn/error-message-qualifier` flags a `.` and identifier character right after an interpolation in an `Error` message, such as `${schema}.current`. (#116, #203)
