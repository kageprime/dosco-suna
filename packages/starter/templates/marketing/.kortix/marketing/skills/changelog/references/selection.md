# What goes into the changelog

## Keep

A change a user of the product can notice:

- a new feature, page, command, API field, config option or integration;
- a changed behavior or default;
- a bug fix a user could have hit;
- a performance change a user feels (with the number when the pull request
  shows one);
- a security fix (one line, no exploit detail);
- a removal or deprecation.

## Skip

- `chore`, `ci`, `test`, `build`, `style`, `refactor` with no behavior change;
- dependency bumps without a user-visible effect;
- internal tooling, docs-only changes to contributor docs;
- the marketing pull requests themselves (`kortix/marketing-*` branches);
- reverted changes, and the revert itself when both are in the range.

A Conventional Commits prefix is a hint, not a rule: read the diff when the
title and the body disagree with it.

## Merge

Several pull requests that ship one change become one line with every link.
A feature behind a flag that is off by default stays out until the flag is on;
list it under `Not included: behind flag <name>`.
