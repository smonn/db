---
status: accepted
---

# release-please builds releases from PR titles

release-please turns the squash-merged PR titles on `main` into the version bump and `CHANGELOG.md`, through a standing release PR, and the release workflow stages the package with npm trusted publishing for a maintainer to approve. Changesets would work too, but it adds a file to every PR, and projects that want one on every PR end up committing empty changesets. CI already checks that each PR title is a Conventional Commit, so the titles are good enough to serve as release notes.

## Considered Options

- **Changesets**: prose release notes per PR, at the cost of a `.changeset/*.md` file in every PR, empty ones included.

## Consequences

- A PR title is a changelog line, so it has to say what changed for a user. `chore` and `docs` titles stay out of the changelog.
- `bump-minor-pre-major` keeps breaking changes on minor versions until 1.0.
- Release candidates use `release-as` or `prerelease-type: "rc"`. Backports go on an `N.x` branch cut from the release tag, with the action's `target-branch` input. Both [v4.4.1](https://github.com/googleapis/release-please-action/blob/v4.4.1/action.yml) and v5.0.0 declare it in `action.yml`, and the [README](https://github.com/googleapis/release-please-action#readme) runs one workflow per target branch ([#330](https://github.com/smonn/db/pull/330)).
- npm needs a manual first publish before a trusted publisher can be attached. The [`npm trust` docs](https://docs.npmjs.com/cli/v11/commands/npm-trust) say: "The package you're configuring must already exist on the npm registry." ([#330](https://github.com/smonn/db/pull/330))
- The release workflow stages the tarball and does not publish it. The maintainer publishes it with `pnpm stage approve` and 2FA.
- release-please opens its release PR with `GITHUB_TOKEN`, so CI on that PR waits for a manual "Approve workflow" click. This stays on purpose. It is a human checkpoint before a release PR runs CI, and it avoids a GitHub App token or PAT with repo write access as a repo secret ([#335](https://github.com/smonn/db/issues/335)).
