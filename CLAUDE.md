## Agent skills

### Issue tracker

Issues live in GitHub Issues for klogpok/claude-vscode-browser, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Branches and releases

Code changes reach `main` through a PR from a feature branch, also when a skill says to commit to the current branch. A release is `npm run release` on a clean, up-to-date `main`: it commits the version bump, tags `v<version>` and pushes both; the tag makes `release.yml` publish the `.vsix`.
