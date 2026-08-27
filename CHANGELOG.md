# Changelog

All notable changes are documented here.

## [0.3.3] - 2026-08-27

### Fixed

- Publication conflict recovery no longer asks a worker to commit a rebase step. The controller now preserves clean paths already staged by Git, gives the worker edit-only authority over exact unmerged files, validates frozen HEAD/index/rebase identity, stages only resolved conflicts, and continues or safely skips an empty replay step itself across merge/apply backends.
- Failed conflict recovery verifies that rebase abort restored the authenticated branch, HEAD, and clean tree; rollback failure is surfaced explicitly instead of being hidden behind the original stall.
- `/leppy-loop status` reports the exact owner-fenced live job first and otherwise the newest authenticated controller, so an old failed run with open work cannot hide a newer publication stall.
- Background and durable status output preserve bounded actionable stall detail, omit undefined fields, and distinguish publication authorization from ordinary continuation.

### Security

- Publication conflict workers have no commit or exec tools. Any index/HEAD/rebase drift, changed unmerged set, untracked path, or edit outside the exact conflict set aborts and restores the authenticated pre-publication branch before push.

## [0.3.2] - 2026-08-27

### Added

- Explicit publication can recover an interrupted Git rebase through fresh workers scoped only to exact unmerged paths, with at most three controller-side repair cycles per human grant.
- The final checklist gate is rerun on the rebased branch before any push or pull-request mutation.

### Security

- A new publish grant authenticates and aborts any prior interrupted merge/apply rebase, so manual or partially staged resolutions never cross jobs. Live conflict paths must exactly equal Git's unmerged index before a worker can receive them; workers cannot access the checklist, sequencer, gate, push, or `gh`.
- Publication freezes the completed checklist, original branch HEAD, exact base target and final-gate fingerprint. A one-shot gate receipt bound to the rebased HEAD is mandatory before push; every integrity or gate failure restores and verifies the clean pre-publication branch.

## [0.3.1] - 2026-08-27

### Added

- `/leppy-loop publish` and `/leppy-loop publicar` now authorize idempotent PR publication after a local-only run has already completed.

### Security

- Post-completion publication selects only the newest authenticated controller with `status=completed` and no open checklist row, binds its immutable authority digest into a one-shot remote-publication grant, and keeps publication absent from model arguments.

## [0.3.0] - 2026-08-27

### Added

- `/leppy-loop`, `continue`, `stop`, `status`, and explicit publication language are now the complete human Web surface; paths, refs, run IDs, repair flags, scopes, fingerprints, and cycle counts remain private technical facts.
- Direct human intent mints an expiring, one-shot capability bound to the exact live Agent/session, canonical repository, authenticated run, operation, iteration/repair bounds, and publication authority. Cross-session/repository/run use and replay fail closed.
- The agent-scoped `leppy_loop_control` tool validates the grant and transfers controllers into the Harness job registry, returning a job ID immediately. General controller status, elapsed time, terminal state, and direct Stop are visible in a dedicated Web card.

### Changed

- Web slash RPCs no longer await the controller. Worker, gate, and fetch cancellation flow from `ctx.jobs.kill`; cancellation preserves dirty WIP and the open controller row for exact recovery.
- Task cards render `Running`, attempt, and elapsed duration in separate non-shrinking elements while only the long task label elides; terminal output remains on the same card.
- Exact continuation selects the most recently updated HMAC-authenticated run with open work and reconstructs checklist/base facts from its preserved controller. Technical argv remains available only through the separate CLI startup composition.

### Security

- Retry, repair, stop, and remote publication cannot be self-authorized by model booleans. Existing clean-worktree, unchanged-gate-fingerprint, exact-run ownership, bounded repair, and publication checks remain defense in depth.

## [0.2.24] - 2026-08-27

### Changed

- One direct `--repair-gate` invocation now chains up to three bounded `fresh closure worker → exact gate retry` cycles by default, feeding each new gate receipt into the next worker instead of stalling after the first newly revealed downstream failure.
- `--repair-cycles <1..8>` allows a direct human to choose the bound. Cycle usage and limits are persisted in events and final resume receipts; the option remains absent from the model-facing tool.

### Security

- Chained repair still fails closed on dirty worktrees, changed gate fingerprints, worker failure, invalid scopes, cancellation, or cycle exhaustion. It never becomes an unbounded automatic loop.

## [0.2.23] - 2026-08-27

### Added

- Direct exact-run gate repair accepts one or more `--repair-path` values to authorize narrowly scoped generated artifacts or dependencies missing from the original closure contract. The additional paths must already exist inside the preserved worktree, are recorded in repair state/events and worker instructions, and remain absent from the model-facing tool.

### Fixed

- Worker `leppy_exec` now treats an explicit `cwd` of `.` like its documented omitted-root default, allowing required repository-root validation and generation commands without widening file commit scope.
- Subsequent failed-gate resume receipts preserve the controller-authorized additional repair paths.

## [0.2.22] - 2026-08-27

### Fixed

- Exact authenticated recovery now resolves and lints the checklist from the preserved run worktree before adoption, so it continues even when the receiving source checkout switched to a branch without that checklist or contains unrelated dirty changes.
- A missing source-side checklist path no longer fails in `realpath` before the exact run can be authenticated; fresh runs retain the clean tracked source-checkout requirement.

## [0.2.21] - 2026-08-27

### Added

- A direct exact-run `--repair-gate` recovery reopens the completed closure immediately preceding a failed gate, feeds the bounded durable gate receipt to a fresh scoped worker, records a controller reopen commit, and retries the unchanged gate fingerprint after the closure succeeds.

### Changed

- Gate-failure receipts now recommend controlled repair while preserving a separate `--retry-gate` command for transient failures.
- The autonomous resolver prompt explicitly forbids source/worktree edits, subagent repairs, publication and integration after a stalled, failed or interrupted controller result.

### Security

- Gate repair is absent from the model-facing tool, requires a clean authenticated worktree plus the exact run ID, and refuses manually modified stalled worktrees.

## [0.2.20] - 2026-08-27

### Fixed

- Terminal `turn/end` and streaming `finish` errors emitted by the isolated Harness SDK runtime are now propagated even when `run()` resolves with an empty final response.
- Codex overload, temporary-unavailability, rate-limit and HTTP 502/503 terminal notifications are classified as availability failures, selecting the configured/adaptive Sol recovery once and otherwise stalling with an exact resume receipt instead of entering zero-commit verification.

## [0.2.19] - 2026-08-27

### Fixed

- A failed controller gate can now be retried on the preserved authenticated run through a direct slash/CLI invocation containing both the exact `--recover-run` ID and `--retry-gate`. The model-facing tool cannot grant this authority.
- Gate failures and unauthorized recovery attempts persist an exact actionable retry receipt instead of claiming that a new invocation is sufficient while permanently rejecting it.

## [0.2.18] - 2026-08-26

### Added

- Tracked `.leppy-loop.json` `customInstructions` are forwarded to every scoped worker with strict object, type and byte limits.
- Open `[human]`/`[human/live]` checkpoints stall without starting a worker and produce an exact recovery receipt.
- Model-facing and direct-command dry runs now expose checklist lint diagnostics instead of silently returning only a preview status.

### Changed

- The checklist parser accepts indented Markdown continuation lines plus legacy `[closure]`/`[gate]`, `Paths:`, `Paths EXATOS:`, `Paths permitidos:` and multiline `Done:` forms while retaining the canonical one-line pipe format.

## [0.2.17] - 2026-08-26

### Changed

- Progress cards now measure elapsed wall-clock time from the start to the terminal event of each individual task attempt instead of accumulating from the beginning of the whole Leppy run. The browser still ticks locally without per-second Session events.

## [0.2.16] - 2026-08-26

### Added

- After a clean zero-commit completion, the single recovery-policy retry may independently verify that the `Done:` contract is already satisfied. Only an exact final `LEPPY_ALREADY_SATISFIED:` evidence line with a clean unchanged branch closes the row through a controller checklist commit; missing evidence still fails closed.

## [0.2.15] - 2026-08-26

### Fixed

- `leppy_commit` now discovers ignored untracked files only inside the task's declared path scopes and force-adds the exact validated changed-path set. This permits explicitly scoped versioned migrations while preventing broad `git add -f` from staging unrelated ignored files.

## [0.2.14] - 2026-08-26

### Added

- Web progress cards now use a plugin-owned client renderer whose cumulative elapsed timer updates locally once per second while a row is running, without writing per-second Session events or entering model context.

### Fixed

- A clean ordinary-task attempt that reports completion without a commit is retried once automatically with the recovery policy (Sol/low under the adaptive OpenAI policy), while dirty WIP and a repeated no-commit result still fail closed.
- The Cordis bundle now mounts the package root so DeepSeek Harness can discover both the Host plugin and its declared browser bundle.

## [0.2.13] - 2026-08-26

### Added

- Every terminal progress card now includes cumulative wall-clock time since the original run started, preserved across recovery (for example, `Task completed — 14/57 — 5m 46s elapsed.`).

## [0.2.12] - 2026-08-26

### Changed

- Progress-card outcome text is now consistently English (`Task completed`, `Task stopped`, and `unknown error`) regardless of the checklist or chat language.

## [0.2.11] - 2026-08-26

### Added

- Web sessions now receive one durable, model-invisible progress card when each checklist row starts; the same card settles visibly when that row completes, stalls, or fails.
- The runner exposes a composition-safe `onProgress` callback with task identity and completed/total counts.

### Fixed

- Web runs now complete locally by default; remote push and pull-request creation require a direct, human-authored `--open-pr` command. The model-facing tool no longer exposes publication, so an autonomous recovery cannot re-enable it and stall an otherwise completed loop.
- Fresh runs now reject checklists with zero open executable rows before creating a worktree, and bare-command orchestration treats such controllers as already finished instead of reporting a false zero-task success.
- Fresh runs also validate the checklist inside the authoritative base worktree and roll it back when that base has no matching open row, even if the source checkout points at a newer open controller.

## [0.2.10] - 2026-08-25

### Fixed

- Bare `/leppy-loop` now treats contractless pending or blocked checkbox prose as an invalid legacy controller and asks the human instead of guessing or calling `leppy_loop_start`.

## [0.2.9] - 2026-08-25

### Added

- Completed Web runs now fetch/rebase, push their exact Leppy branch, create or find an idempotent GitHub pull request through authenticated `gh`, and return/store its URL by default.
- Added `--no-open-pr` and `leppy_loop_start.openPullRequest: false` opt-outs.

### Security

- Remote publication remains controller-only after successful checklist/gate completion; workers still cannot invoke push, `gh`, publication, merge, or deployment operations.

## [0.2.8] - 2026-08-25

### Fixed

- An exact `recoverRunId` can now continue a completed selective run on the next open row in its preserved branch/worktree instead of returning `no authenticated matching WIP run exists`.
- Recovered state is written as `running` immediately and records its previous status in the recovery event.

## [0.2.7] - 2026-08-25

### Fixed

- Recovery now prefers the sole intentionally recoverable stalled/interrupted run when older authenticated failed runs exist.
- Added exact `--recover-run <id>` and `leppy_loop_start.recoverRunId` selectors; generated resume commands carry the run ID to remain deterministic.

## [0.2.6] - 2026-08-25

### Added

- Added `adaptive`, `selected`, `terra-high`, and `sol-low` worker policies. Adaptive uses Terra/high for ordinary OpenAI Codex work and Sol/low for closures and recovered or availability-retried work.
- Exposed `--worker-policy` and the equivalent `leppy_loop_start.workerPolicy` argument while retaining task and command overrides.

### Fixed

- Raised the default JSON-RPC transcript cap from 2 MiB to 8 MiB so streamed OpenAI Codex sessions can finish without premature `transcript-limit` stalls.

## [0.2.5] - 2026-08-25

### Fixed

- `@deepseek-ai/dsh-tools` now resolves as a Host-shared peer in installed workers, preserving the private scheduler symbol used for parallel model tool calls.
- OpenAI Codex workers can issue multiple `leppy_*` calls in one model step without failing at `TOOL_RUNTIME_SCHEDULER.prepare`.

## [0.2.4] - 2026-08-25

### Fixed

- Removed the controller's hidden `deepseek-official` default so an omitted `--provider` now preserves the Harness-selected provider and validates the model against the matching catalog.

## [0.2.3] - 2026-08-25

### Fixed

- Natural-language suffixes such as `/leppy-loop e agora?` are now forwarded to the AI as intent instead of being rejected by the explicit argv parser.

## [0.2.2] - 2026-08-25

### Fixed

- Isolated workers now preserve the Harness-selected provider and model profile instead of always requiring `DEEPSEEK_API_KEY`.
- Added `llm-pi-ai` and shared Harness credential-store routing for configured providers such as `openai-codex`.

## [0.2.1] - 2026-08-25

### Added

- Bare `/leppy-loop` orchestration: the AI resolves the intended checklist and Git base, then calls the private `leppy_loop_start` controller tool.
- Ambiguity handling that asks the human instead of guessing a checklist or base.

### Changed

- Explicit `--tasks` and `--sync-branch` arguments are now optional UX rather than the primary path.

## [0.2.0] - 2026-08-25

### Added

- Installable Host-side `/leppy-loop` command for the DeepSeek Harness Web composer.
- Quoted, non-evaluating command-input grammar with session-workspace path resolution.
- UI and plugin-lifetime cancellation propagation into controller operations.
- Typed dry-run previews returned through the command result plane.

### Changed

- The default bundle is command-only and no longer disables Harness HMR; the separately exported CLI startup claims argv only when `--tasks` is present.
- Installation documentation and runtime smoke coverage now target the existing `web` profile.

## [0.1.0] - 2026-08-22

### Added

- Native Cordis bundle pinned to DeepSeek Harness `0.1.1-rc.2`.
- Typed Markdown checklist parser/linter with task, closure, and gate lines.
- Single-worktree controller with one ephemeral SDK process/session per worker.
- Scoped file tools, sandboxed argv execution, and narrow conventional-commit capability.
- Atomic durable state, repository lock, HMAC leases, authenticated recovery, limits, and redaction.
- Versioned eleven-event public union and library API.
- Deterministic fake-adapter suite and real keyless JSON-RPC Harness smoke.
- Cross-platform CI, bilingual documentation, architecture, threat model, contribution and security policies.
