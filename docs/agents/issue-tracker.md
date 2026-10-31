# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: write the body to a file, then `gh issue create --title "..." --milestone "<title>" --body-file <file>`.
- **Write an issue body**: link the spec the work follows in Problem: an ADR, an issue comment, or a prototype file as `<branch>:<path>`. When issues split an ADR's consequences, give each consequence an owning issue, so none falls between them. Back each claim about the code or a tool with the file path, installed version, or reproduction you checked.
- **Read an issue**: `issue-read <number>`. To edit a body, fetch the raw text with `gh api repos/smonn/db/issues/<number> --jq .body`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Claim an issue**: `gh issue edit <number> --add-assignee @me`, before starting work on it.
- **Comment on an issue**: `gh issue comment <number> --body-file <file>`
- **Edit an issue body**: `gh issue edit <number> --body-file <file>`. Revise the affected section in place so the body reads as current, and delete lines that no longer hold. Put the history in a comment, not an "Update:" paragraph.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Testing tracker tooling

Never create, edit, or close a live issue on `smonn/db` to test tooling: a test issue shows up in other agents' `node scripts/frontier.ts` output (#132). Test against recorded payload fixtures with `node:child_process` mocked (`scripts/fixtures/`, `ghReturns` in `scripts/frontier.test-helper.ts`). Lint enforces the mock: `smonn/mock-child-process` fails a `scripts/**/*.test.ts` that imports a value from `node:child_process` without `vi.mock("node:child_process", ...)`. It cannot see an indirect call through an unmocked script module, so mock `gh` at the script's boundary.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --json body,comments,reviews` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Breakdown size

**Stage breakdowns past: none.** _(Set to a ticket count, such as `8`, to have `/to-tickets` cut scope or split a larger breakdown into stages that each ship.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev. Cite a file on another branch as `<branch>:<repo-relative path>`, the form `git show` takes. A research ticket's note lives at `research/<slug>:docs/research/<slug>.md`.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub's `issue_dependencies_summary.blocked_by` count can stay stale after a blocker closes, so read blocker states instead. Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `node scripts/frontier.ts <map>` prints the map's open, unassigned children with no open blocker, in map order; the first line wins. After those lines it warns on stderr for each closed child whose URL the map body lacks, with the exit code unchanged. Without `<map>` it prints every open, unassigned issue with no open blocker, oldest first, skipping pull requests, maps, issues with sub-issues, and Renovate's Dependency Dashboard. It reads native dependencies only, not `Blocked by` lines.
- **Claim**: as in **Claim an issue** above, the session's first write.
- **Resolve**: `gh issue comment <n> --body-file <answer-file>`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far. Edit an issue body's list only with `node scripts/issue-section.ts <n> --section "<## heading>" --append <line-file>`: it adds the file's lines at the end of that section's list, reads the body right before it writes, and exits 1 without writing when the heading is missing or repeated. Use it for the map's Decisions so far and Out of scope sections and a ticket's Done when, passing the heading line exactly as the body spells it. Closing by hand is the exception to AGENTS.md's `Closes #<n>` rule: the ticket closes at resolution, so a later PR that records its decision, such as an ADR, links it with `Related to #<n>`.
