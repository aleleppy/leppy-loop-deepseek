---
name: leppy-loop
description: Operate one bounded Leppy Loop lifecycle from natural language. Use for /leppy-loop, Leppy status/continue/repair/publication, or when a user refers to an existing Leppy task card.
---

# Leppy Loop lifecycle

The Host plugin—not this chat—is the controller of checklist mutation, worker worktrees, commits, recovery, gates, and publication.

## Non-negotiable control rules

1. Use `leppy_loop_control`; never emulate Leppy with shell commands, file edits, subagents, workflows, Ralph, or generic background jobs.
2. Before saying a run or job is active, call `leppy_loop_control` with `operation: "status"`. Only a live `jobId` returned by that call proves a Host job exists.
3. Never invent, remember, or pass a `leppy-loop-*` job ID across turns. Job IDs are session-local observations, not durable run identity. The authenticated `runId` is durable.
4. If status is `orphaned`, the durable controller exists but no owned Host job does. Continue the exact authenticated run through `operation: "continue"`; do not call `job_output` or start a subagent.
5. A single `/leppy-loop` authorizes only one bounded lifecycle. Reuse its persisted same-session authority for controller transitions; never widen scope, merge, deploy, or start another run.
6. If the Host reports that durable authority is absent or belongs to another session, state that fact exactly. Do not claim continuation started.

## New-run preflight

Before `operation: "start"`, resolve one tracked checklist and the authoritative Git base, then call `operation: "preflight"`. Start only when it returns `ready`. If it returns `invalid`, correct only the reported path/Done metadata in the tracked source checklist and rerun preflight; no Leppy worktree exists yet.

For every open task or closure row:

- Prefer explicit `paths=repo/relative/path,...` metadata.
- Use canonical repository-relative paths, not a basename that exists only in a nested directory.
- Never use extension fragments such as `.ui`, brace expressions such as `src/{main,test}`, or globs; Leppy does not expand them.
- Include every file or directory the worker may need to modify. If the Done contract requires tests, include an explicit test/spec write scope.
- Keep the controlling checklist out of worker paths.
- Ensure each task has a concrete Done contract; closures must be adjacent to their gate and remain fail-closed.

Do not silently “fix” an already authenticated run's checklist or base. For an existing run, use only exact Host-returned controller facts.

## Transition selection

- `status`: inspect availability and durable progress; this is read-only and requires no remembered job.
- `start`: only after a direct human `/leppy-loop` permit and successful preflight.
- `continue` + `resume`: recover an interrupted, stalled, or orphaned exact run.
- `continue` + `retry-gate`: retry only the exact recorded failed gate.
- `continue` + `repair-gate`: reopen the authenticated preceding closure within bounded repair authority.
- Stop is not model-authorized. A human may use `/leppy-loop stop`; never attempt `operation: "stop"` from the model tool.

Return after the Host accepts and starts a controller job. Do not monitor it with generic job tools; Leppy emits its own durable task cards and autonomous follow-ups.
