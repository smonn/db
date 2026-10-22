# AGENTS.md

## Pull requests and issues

- Write PR bodies from `.github/pull_request_template.md` and issue bodies from `.github/ISSUE_TEMPLATE/issue.md`. `gh pr create` and `gh issue create` skip templates, so copy the sections yourself.
- Keep every section and replace its comment. Write one line or `n/a` when a section has little to say.
- Write tight: each sentence is a fact the reader needs.
- Title PRs as Conventional Commits (`type(scope): summary`) in the imperative. Title issues by the problem.
- File every issue with a milestone. Pick it by the milestone descriptions (`gh api repos/smonn/db/milestones`). Repo tooling goes in the earliest open milestone.
- Keep each PR to one self-contained change.
- Link every PR to its issue in the template's Issue section. Use `Closes #<n>` so merging closes the issue, and don't close it by hand. Closing keywords only fire on PRs into `main`.
- Agents may commit, push, and open a draft PR without asking. Mark it ready for review once CI passes, or right away while the repo has no CI. Only the maintainer merges, unless they approve an agent merging that PR.

## Repo tooling

- Enforce a rule with a static check in CI whenever one can express it: a lint rule, a semantic-grep rule, a `scripts/` check, a type test, or mutation testing. Document only what no tool can check.
- Write repo scripts in TypeScript under `scripts/`, run directly by Node. A shell file may only invoke one. Scripts get the same tests, lint, and formatting as `src/`.
- Tests need Postgres: run `node scripts/test-db.ts` once per worktree, then plain `pnpm test`; `node scripts/test-db.ts stop` removes it.

## Coding standards

- Read `CODING_STANDARDS.md` before writing or reviewing code.

## Design decisions

- Write every ADR from `docs/adr/TEMPLATE.md`, which also holds the numbering and when-to-write rules.
- Agents draft ADRs in `docs/adr/` with `status: proposed`. Only the maintainer moves one to `accepted`.
- Give each ADR a rationale paraphrased from the maintainer's reasoning, in plain prose rather than verbatim quotes.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `smonn/db`, managed with the `gh` CLI. Claim an issue by assigning it (`--add-assignee @me`) before starting work. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Every implementation issue also gets an `area:*` label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
