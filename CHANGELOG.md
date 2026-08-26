# Changelog

All notable changes are documented here.

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
