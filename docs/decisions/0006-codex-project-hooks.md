# 0006: Codex project hooks and a committed shim

Status: accepted

## Context
The Codex CLI (0.166) does not run plugin hooks: `plugin/read` returns
`"hooks": []`, and a guarded `git push origin main` ran unblocked with the plugin
installed. Project hooks in `.codex/hooks.json` do run, but they get no plugin
root variable, no project-dir variable, and run from the session cwd (which can
be a subfolder) through `cmd.exe` on Windows. See `docs/codex-mapping.md`
("Hooks") and ADR 0007.

## Decision
`node scripts/codex-hooks.js [--project <dir>] [--check]` writes two files in the
project's `.codex/` folder (CD-12 wires it into team-init):

- `agent-team-hook.js`, a copy of `templates/project/.codex/agent-team-hook.js`.
  Commit it.
- `hooks.json`, derived from the plugin's `hooks/hooks.json`: same events,
  matchers and timeouts, with each command replaced by one call to the shim
  (`guard`, `log-delegation` or `session-start`). Claude-only matchers stay; they
  never match on Codex. An existing file is merged, not replaced: our entries
  (recognised by `agent-team-hook.js` in the command) are rewritten in place,
  everything else is kept, and a second run changes nothing. A hooks.json that
  does not parse is never overwritten (exit 1 with a message). `--check` lists
  missing or out-of-date files and exits 1.

**One command per script.** The command is the same string in every project and
on every machine, with no absolute path:

    node -e "try{require(require('path').join(require('child_process').execFileSync('git',['rev-parse','--show-toplevel'],{stdio:['ignore','pipe','ignore']}).toString().trim(),'.codex','agent-team-hook.js'))}catch(e){console.error('agent-team hook shim not found; ...')}" guard

It finds the git root itself, so it works from a subfolder. It uses double quotes
outside and single quotes inside, no backslashes, `$` or `|`, so sh, cmd.exe and
PowerShell read it the same way. Because the string is stable, Codex's per-hook
trust hash does not change when the file is regenerated. If git or the shim is
missing it warns on stderr and exits 0.

**The shim** (`.codex/agent-team-hook.js <script>`):
- sets `AGENT_TEAM_HOOK_SOURCE=project`, `CLAUDE_PROJECT_DIR=<project root>` (the
  folder above `.codex/`), `CLAUDE_PLUGIN_ROOT=<plugin root>`, and
  `AGENT_TEAM_TOOL=codex` unless already set;
- finds the plugin root: `AGENT_TEAM_PLUGIN_ROOT`, then the highest version of
  `<CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/agent-team/<version>/`
  (compared as semver, not as text), counting only folders that contain
  `scripts/log-delegation.js`;
- runs the script with stdin passed through, relays its stdout (the guard's deny
  JSON) and stderr, and exits with its exit code;
- if no plugin is found, prints `agent-team plugin not found; guard and logging
  off; GitHub rulesets still apply` on stderr and exits 0 (fail open). It never
  writes anything else to stdout.

**No double logging.** `scripts/codex-log.js` ignores a Codex event that comes
through a plugin hook (`AGENT_TEAM_HOOK_SOURCE` unset) when the project's
`.codex/hooks.json` references the shim. If a future CLI runs both, the project
hooks win and each event is logged once. (The guard may run twice; that is
harmless.)

**Trust.** Codex runs a project hook only after it is trusted, once per project:
open `/hooks` or accept the startup prompt. Untrusted hooks fail silently, with
no error, so `codex-hooks.js` prints a reminder and the SessionStart "hooks:
active" line (ADR 0007) is the check that they are running. Regenerating after a
plugin update that changes the hook set means trusting the changed hooks again.

## Alternatives
- **Vendor the hook scripts into the project.** Works offline and needs no
  lookup, but copies the guard into every repo, where it goes stale and needs a
  per-repo update on each release. The shim is small and rarely changes.
- **Absolute plugin paths in hooks.json.** Differ per machine and per plugin
  version, so a committed file would break for teammates and change the trust hash
  on every plugin update.
- **User-level hooks (`~/.codex/hooks.json`).** Would guard and log in every
  repo, including ones that never opted in to agent-team.

## Consequences
- Codex projects need `.codex/hooks.json` and the shim committed, plus a one-time
  trust step per project (and again when the hook set changes).
- Hook scripts run from the plugin cache, so a plugin update takes effect without
  touching the project. The shim only needs regenerating when the template or the
  hook set changes (`--check` shows it).
- Codex Desktop, which may run plugin hooks, is not covered by live tests; the
  skip rule above prevents double logging if it does.
- `lib.projectDir` now remembers its git lookup per cwd within a process, so a
  Codex hook run spawns git once instead of on every call.
