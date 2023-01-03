# Auto Rebase

This action rebases all open PR's when the base branch in updated.

## Inputs

### `github_token`

**Required** Github token for the repository

### `filter`

`auto-merge` **default**  Only rebase PR's set automatically merge when all requirements are met

`always` Rebase all PR's to the current branch

### `max_mergeable_rebases`

`0` **default**: rebase as many PRs as possible

positive integer: if there are any PRs that are immediately mergeable
_but for_ their needing to be rebased, rebase this many of these sorts
of PRs. If none of the PRs found will be mergeable after rebasing
(e.g., they still require review approval or haven't yet passed CI).
If, however, all PRs against the base branch will _not_ be immediately
mergeable, rebase them all.

Note that if your CI checks run in Github and your token is set up to
allow this rebase action to retrigger additional actions, this mode will
be retriggered after the merges succeed. This can the be very useful,
but it can also cause an excessive number of job runs if you don't set
this `max_mergeable_rebases` limit (or if you don't limit the branches
to which this action applies, since the action itself will create a
temporary branch as part of the rebase).

## Example usage
```yaml
on:
  push:
    branches:
      - main

jobs:
  rebase:
    runs-on: ubuntu-latest
    steps:
      - uses: jimbloemkolk/auto-rebase@v0.1.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```
