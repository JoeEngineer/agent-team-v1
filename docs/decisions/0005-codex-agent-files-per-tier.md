# 0005. Codex agent files per role and tier, generated per machine

## Context

Claude Code subagents pick a model from the `model:` field in `agents/*.md`. Codex has no per-spawn model parameter: a spawn can set `reasoning_effort`, but the model comes from the agent definition (a TOML file with `name`, `description`, `developer_instructions`, and optionally `model` and `model_reasoning_effort`). To route a task to a tier, the Director must therefore spawn an agent whose file already pins that tier's model. See "Agents and delegation" and "Models and effort" in `docs/codex-mapping.md`, and decision 0001 for the model map.

Verified on Codex CLI 0.166: an agent file that pins only `model` leaves the per-spawn `reasoning_effort` in effect (a spawn with `high` ran at `high`), and hyphenated names such as `implementer-medium` spawn fine.

## Decision

- `scripts/codex-agents.js` writes `<role>-<tier>.toml` for every `agents/*.md` and every Codex tier that is auto-eligible or explicitly `enabled: true` (on the tier or the entry). With the default map that is 5 roles x small/medium/large = 15 files; xlarge only when the user enables it.
- Each file sets `name`, `description` (the role description plus ` (tier <tier>)`), `model` from the effective map (`models.loadMap()`, so the user override applies) and `developer_instructions` (the Markdown body). It does not set `model_reasoning_effort`; the Director passes effort per spawn.
- The first line is a header comment naming the plugin version, role and tier. The generator only overwrites or deletes files that carry the header; any other file is kept with a warning. Files for roles or tiers no longer produced are deleted. `--check` reports missing, stale or out-of-date files with exit 1; `--dry-run` changes nothing.
- Output goes to `<git root>/.codex/agents` by default. The files are per machine and gitignored, because they bake in the account's model map. They are regenerated, not committed.
- A map with no Codex entries generates nothing and removes earlier generated files.

## Alternatives considered

- **Role x tier x effort files (45):** triples the files for no gain, since per-spawn `reasoning_effort` already works when the file does not pin it.
- **Unpinned files (one per role):** impossible, because there is no per-spawn model parameter; the tier would have no way to select a model.
- **User-level `~/.codex/agents/`:** would leak one project's role set and model map into every project, and collide across plugin versions.
- **Committed files:** the models depend on the account (decision 0001), so committed files would be wrong for other users and drift from their override.

## Consequences

- Changing the model map or updating the plugin requires re-running the generator; `--check` detects drift.
- A hand-written agent file with the same name is never overwritten, so it also shadows the generated one.
- Role names with characters unsafe in file names are sanitised in the file name only; the `name` key keeps the role as written.
