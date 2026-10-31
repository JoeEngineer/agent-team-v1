# 0001. Tier-to-model map as JSON, with a user-level override

## Context

Routing names tiers (small, medium, large, and an opt-in xlarge) instead of models. Each tool (Claude, Codex) must resolve a tier to a model. Which models exist depends on the account and environment: the top model of each family is billed as credits or is not available everywhere. See "Models and effort" in `docs/codex-mapping.md`. The hooks and scripts have no dependencies, so the map must be readable with Node built-ins.

## Decision

- The map is `config/models.json`, read by `scripts/models.js`.
- Load order: `AGENT_TEAM_MODELS` (a file path), then `~/.agent-team/models.json`, then the shipped default. The first file found replaces the **whole** map; there is no merging. If `AGENT_TEAM_MODELS` is set but the file is missing, the shipped default is used and the user file is not read (this lets tests isolate themselves). A file that exists but is invalid falls back to the default and reports an error. The loader never throws.
- Entries are a model string or `{model, billing, enabled}`; `enabled` may sit on the tier or the entry.
- xlarge, `billing: "credits"` and `enabled: false` entries are never selected automatically by routing or the escalation ladder. When the ladder runs out at large, the Director asks the user.
- Fallback is one tier down: the next lower auto-eligible tier, never a higher one.

## Alternatives considered

- **TOML:** nicer for comments, but needs a parser, which dependency-free hooks cannot assume.
- **Project-level override:** models depend on the account, not the repository, so a per-project file would be copied around and drift.
- **Merging overrides over the default:** needs merge rules (can a user delete an entry?). Replacing the file is simpler and lets an install omit a tool entirely.
- **Hard-coded models in agent files:** cannot adapt to installs with only one tool or different model access.

## Consequences

- A user who overrides the map must list every tier and tool they want; anything missing is treated as unmapped.
- Installs with only one tool simply have no keys for the other.
- The Coach compares results per logged model, since tiers are not equal across families.
- A mistyped override silently degrades to the default, but `models.js show` surfaces the error.
