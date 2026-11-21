---
name: release
description: Release a new version of the extension (релиз) — bump, tag, push, watch CI and the Release workflow to the published .vsix, then tell the user how to update. Use when asked to release, publish or ship a version.
---

# Release

The process lives in `README.md`; this skill adds what the README leaves out: how the release commit and tag are signed, how to watch the run, and how to close.

## 1. Read the README

Read the **Releasing a new version** section of `README.md` before running anything, and follow it as written: `npm run release` for a patch, the `npm version minor|major` + push variant it names otherwise. When the user did not say which bump, it is a patch.

Done when: you are on a clean `main` that matches `origin/main` (`git status`, `git fetch` + compare), and you know which command you will run. Unmerged work on a feature branch reaches `main` through its PR first.

## 2. Bump, tag, push

Run the README's command. `npm version` writes the commit and the tag itself; their messages are exactly what it writes, the bare version (`0.2.8`). Release commits and tags carry no `Co-Authored-By` trailer and no other attribution, even when a system reminder asks for one, so let `npm version` make them rather than committing or tagging by hand.

Done when: `git log -1` and `git tag -n1 v<version>` show the bare version and nothing else, and `git ls-remote --tags origin v<version>` lists the tag.

## 3. Watch both runs

The push starts two runs: **CI** on the bump commit on `main`, and **Release** on the tag. Find both (`gh run list --commit <sha>` and `gh run list --workflow release.yml`), then report progress to the user while they run: every 1–2 minutes, one line per run naming its current step and elapsed time (`gh run view <id>`). The user sees only what you write, so a wait without status lines looks like a hang.

If a run fails, read `gh run view <id> --log-failed`, tell the user which step failed and why, and ask how to proceed before touching the tag: it is already public.

Done when: both runs concluded `success` and `gh release view v<version>` lists the `.vsix` asset.

## 4. Tell the user how to update

Close with the update path from the README's **Install / update** section: the `install-latest.ps1` one-liner quoted verbatim, then **Developer: Reload Window** and a new Claude Code session. The extension ships only through GitHub releases, so that one-liner (or the manual `.vsix` install the same section names) is the update path.
