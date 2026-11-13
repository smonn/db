---
status: accepted
---

# `--json` prints one document per command

With `--json`, every command prints one JSON document on stdout, on success or failure, so a script or an agent has one parse path instead of reading prose. A failure's `error` carries a code from a small closed set, because an agent needs a code only to choose a fix. The shape has no JSON Schema and no version field before v1.0, since it will still move, and a change to it is a breaking change that the release notes flag.

## Considered Options

- **A JSON Schema or a `version` field**: promises a stability the shape does not have yet.
- **A code per refusal**: more to document, and no extra fix for an agent to pick.

## Consequences

- Each document has `command` and `ok`. Exit codes stay 0, 1, and 2, stderr keeps progress lines, and a usage error prints JSON too.
- Each document holds what plain mode prints: generate gives its file, Hazards, hints, and the Dev database outcome (ADR-0030), and the other commands give their files, counts, or moves. Field names settle in implementation.
- An `error` holds a `code`, the plain `message`, and fields for that code. The codes are `usage`, `locked`, `hazard_not_accepted`, `catch_up_failed`, `leftover`, `unmodeled_blocker`, `chain_broken`, `not_dev_database`, and `failed` for everything else. A new refusal maps to one of these or extends the set on purpose.
- Watch prints NDJSON events (ADR-0032): `started` with the watched paths, `run` with the generate document plus trigger paths and duration, and `stopped`, so one parser serves both. A refused second watcher prints one failure document and exits 1.
- The types export from `@smonn/db/dev`, one document type per command.
- A `rebase` file that differs from its copy or that the base has and the branch lacks, and a migration file with a bad header or name, are `failed`, not `chain_broken`.
