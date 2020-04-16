# steward

> A GitHub App built with [Probot](https://github.com/probot/probot) that helps you manage PR flow.

## Intro

If you have a fairly long build + CI process that runs on every PR, and you rerun all PRs against
the latest master (e.g. you re-merge PRs onto the latest head), this bot is for you.

In these cases, every merge to master causes all PRs to rebuild, which means if you strictly merge
only PRs that are green and up to date against master, you must wait __build time__ between each
merge. In a repo with high activity and large PR rate, such as a monorepo or monolithic, this
quickly becomes extremely limiting and also a terrible developer experience.

Steward merges PRs for you, and attempts to build merge trains, where multiple ready PRs are
merged at once optimistically. It does not merge all PRs in a merge train into a proposed branch,
which is what something like `bors` (or `bors-ng`) does. Instead, Steward assumes that merge
conflict of this nature happens fairly infrequently, and that you have build + CI against master
that also runs.

In some sense, this is more complicated then a simple merge bot that merges when CI is green on
a per PR basis, but less intelligent then a `bors` style bisecting merge-manager, or GitLab's
merge trains (which build the combined diff set).


## Features

* A UI on `/merge` which enables and disables merging, e.g. in cases like production hotfixes or
master breaking, so that the bot stops merging PRs.

* Cached github responses: fast and never hits the rate limit

## Development
### Dev notes

Node 12, yarn, prettier.

### Next++

* Read from a `.github/config` instead of hard coded labels
* Better `/merge` UI
* Allow custom predictors to better choose PRs in a train, e.g. by checking CI predicted build time
  left, for example.
* Tests

### License

MIT
