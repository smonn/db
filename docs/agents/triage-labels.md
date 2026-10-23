# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Canonical role    | Label in our tracker | Meaning                                  |
| ----------------- | -------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`    | Requires human implementation            |
| `wontfix`         | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Priority

Every issue that reaches `ready-for-agent` or `ready-for-human` carries exactly one priority. It is the urgency lever: `wave` orders work by it, and a `critical` issue preempts planned work.

| Priority   | Label in our tracker | Meaning                                          |
| ---------- | -------------------- | ------------------------------------------------ |
| `critical` | `priority:critical`  | Drop other work: broken for users, no workaround |
| `high`     | `priority:high`      | Next in line                                     |
| `medium`   | `priority:medium`    | Default                                          |
| `low`      | `priority:low`       | When nothing else is waiting                     |

## Category labels

Every triaged issue also carries exactly one category label. Issues filed before this rule carry none until they are next triaged.

| Category      | Label in our tracker | Meaning                    |
| ------------- | -------------------- | -------------------------- |
| `bug`         | `bug`                | Something is broken        |
| `enhancement` | `enhancement`        | New feature or improvement |

## Area labels

Every implementation issue also carries at least one `area:*` label naming the part of the codebase it changes. Wayfinder maps and their tickets carry none.

| Label             | Covers                                |
| ----------------- | ------------------------------------- |
| `area:tooling`    | Build, lint, CI, and release tooling  |
| `area:definition` | Definition API and column types       |
| `area:diff`       | Catalog, introspect, diff, and Shadow |
| `area:migrations` | Migration files, hash chain, migrator |
| `area:queries`    | sql, query builder, and client        |
| `area:cli`        | Config and `smonndb` commands         |

Add a new `area:*` label here before applying it.
