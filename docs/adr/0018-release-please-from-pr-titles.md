---
status: proposed
---

# release-please builds releases from PR titles

release-please turns the squash-merged PR titles on `main` into the version bump and `CHANGELOG.md`, through a standing release PR, and the release workflow publishes with npm trusted publishing. Changesets would work too, but it adds a file to every PR, and projects that want one on every PR end up committing empty changesets. CI already checks that each PR title is a Conventional Commit, so the titles are good enough to serve as release notes.

## Considered Options

- **Changesets**: prose release notes per PR, at the cost of a `.changeset/*.md` file in every PR, empty ones included.

## Consequences

- A PR title is a changelog line, so it has to say what changed for a user. `chore` and `docs` titles stay out of the changelog.
- `bump-minor-pre-major` keeps breaking changes on minor versions until 1.0.
- Release candidates use `release-as` or `prerelease-type: "rc"`. Backports go on an `N.x` branch cut from the release tag, with the action's `target-branch` input. Unverified: that the v4 action accepts `target-branch`.
- npm may need a manual first publish before a trusted publisher can be attached. Unverified.
