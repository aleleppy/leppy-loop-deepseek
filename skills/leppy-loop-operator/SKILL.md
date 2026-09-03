---
name: leppy-loop-operator
description: Model-only guidance for operating an already human-authorized Leppy lifecycle, status, recovery, or publication.
---

# Leppy Loop lifecycle operator

This skill is model-only. The user-facing `/leppy-loop` name is reserved exclusively for the Host command that creates direct-human lifecycle authority. Never ask a human who already invoked that command to invoke a second skill or phase command.

The Host plugin—not this chat—is the controller of checklist mutation, worker worktrees, commits, recovery, gates, and publication.

## Non-negotiable control rules

1. Use `leppy_loop_control`; never emulate Leppy with shell commands, file edits, subagents, workflows, Ralph, or generic background jobs.
2. For every existing run, the first lifecycle tool call in the turn must be `leppy_loop_control` with `operation: "status"` and the exact `runId`. Only a live `jobId` returned by that call proves a Host job exists; if no live job is returned, use the same response's exact controller facts for at most one transition.
3. Never invent, remember, or pass a `leppy-loop-*` job ID across turns. Job IDs are session-local observations, not durable run identity. The authenticated `runId` is durable.
4. If status is `orphaned`, the durable controller exists but no owned Host job does. Continue the exact authenticated run through `operation: "continue"`; do not call `job_output` or start a subagent.
5. A single `/leppy-loop` authorizes only one bounded lifecycle. Reuse its persisted same-session authority for controller transitions; never widen scope, merge, deploy, or start another run.
6. If the Host reports that durable authority is absent or belongs to another session, state that fact exactly. Do not claim continuation started.

## New-run preflight

Before `operation: "start"`, resolve one tracked checklist and the authoritative Git base, then call `operation: "preflight"`. Start only when it returns `ready`. If it returns `invalid`, correct only the reported path/Done metadata in the tracked source checklist and rerun preflight; no Leppy worktree exists yet.

For every open task or closure row:

- Treat `paths=repo/relative/path,...` as optional context for discovery, never as worker write authority.
- When path hints are present, use canonical repository-relative paths rather than fragments, braces, or globs.
- Never delay or reject a task merely because a possible implementation/test path is absent from metadata; the mutable worker owns the complete isolated repository.
- Keep the controlling checklist out of path hints.
- Ensure each task has a concrete Done contract; closures must be adjacent to their gate and remain fail-closed.

Do not silently “fix” an already authenticated run's checklist or base. For an existing run, use only exact Host-returned controller facts.

## Transition selection

- `status`: inspect availability and durable progress; this is read-only and requires no remembered job.
- `start`: only after a direct human `/leppy-loop` permit and successful preflight.
- `continue` + `resume`: recover an interrupted, stalled, or orphaned exact run. HMAC-bound failed-gate evidence is adopted without rerun; an older pre-evidence stalled gate runs exactly once with repair disabled, then advances advisory.
- `continue` + `retry-gate`: deliberately retry only the exact recorded failed gate; ordinary advancement does not require it.
- `continue` + `repair-gate`: deliberately reopen the authenticated preceding closure within bounded repair authority; automatic local repair already runs before advisory advancement.
- Stop is not model-authorized. A human may use `/leppy-loop stop`; never attempt `operation: "stop"` from the model tool.

Return after the Host accepts and starts a controller job. Do not monitor it with generic job tools; Leppy emits its own durable task cards and autonomous follow-ups.
