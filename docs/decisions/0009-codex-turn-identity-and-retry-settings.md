# 0009: Exact Codex turn identity and effective retry settings

Status: accepted for the proposed Codex integration fix.

## Context

The initial-sync milestone Coach found five requested effort increases that did not take effect, plus missing first-turn durations and resumed durations attributed to the preceding turn. Codex followups preserve agent settings. A SubagentStop hook can run before its turn's task_complete event is appended to the child transcript. Selecting the latest completion therefore records the wrong attempt.

## Decision

Use the stop event's exact child turn ID to bound transcript context, usage, report and completion data. If a known turn is not yet complete, preserve a durable pending snapshot of its delegation and parsed report, then finish recording it on a later hook or explicit reconciliation. Do not wait inside the hook, infer a missing duration as zero, or borrow a later turn's data. Unknown identities retain conservative legacy behavior without claiming exact metrics.

Keep completion identity independent of report text when the turn ID is available. Include task and attempt identity in review deduplication so identical verdicts across retries or a reused agent's new task are retained. Keep requested model/effort distinct from settings observed in the selected turn.

Use warm followups for retries only when retaining settings. An escalation that changes model or effort starts a fresh agent with a unique attempt name, the same isolated worktree, review findings and a compact self-contained handoff. Select settings through the tool interface actually exposed by the current client; a task card or log field cannot apply an override.

## Consequences

Pending stops need durable reconciliation, including in projects without Claude transcripts. Retries with changed settings give up the existing agent's conversation but preserve its worktree and an explicit handoff. Starting-tier routing remains unchanged. Regression tests must reproduce stop-before-completion ordering, delayed reconciliation after another turn starts, stable idempotency, task reuse, missing identities, and requested/observed mismatches. The existing installed plugin and original milestone logs are not edited by this source PR.
