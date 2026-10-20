# AGENTS.md

## Pull requests and issues

- Write PR bodies from `.github/pull_request_template.md` and issue bodies from `.github/ISSUE_TEMPLATE/issue.md`. `gh pr create` and `gh issue create` skip templates, so copy the sections yourself.
- Keep every section and replace its comment. Write one line or `n/a` when a section has little to say.
- Write tight: each sentence is a fact the reader needs.
- Title PRs as Conventional Commits (`type(scope): summary`) in the imperative. Title issues by the problem.
- Keep each PR to one self-contained change.
- Agents may commit, push, and open a draft PR without asking. Mark it ready for review once CI passes, or right away while the repo has no CI. Only the maintainer merges, unless they approve an agent merging that PR.

## Repo tooling

- Enforce a rule with a static check in CI whenever one can express it. Document only what no tool can check.
- Write repo scripts in TypeScript under `scripts/`, run directly by Node. A shell file may only invoke one. Scripts get the same tests, lint, and formatting as `src/`.

## Design decisions

- Write every ADR from `docs/adr/TEMPLATE.md`, which also holds the numbering and when-to-write rules.
- Agents draft ADRs in `docs/adr/` with `status: proposed`. Only the maintainer moves one to `accepted`.
- Give each ADR a rationale paraphrased from the maintainer's reasoning, in plain prose rather than verbatim quotes.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `smonn/db`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
