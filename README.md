# Leppy Loop for DeepSeek Harness

[Português (Brasil)](README.pt-BR.md)

Leppy Loop is a native external Cordis bundle that executes a tracked Markdown checklist with a fresh DeepSeek Harness process and session for each worker line. The controller owns Git synchronization, the worktree, checklist transitions, closure, gates, durable recovery state, and process leases. Workers receive only the current line, its `Done:` contract, writable paths, applicable repository instructions, and explicit prohibitions; ordinary workers may inspect the worktree but cannot write outside those paths or read the controlling checklist.

Version `0.3.22` is pinned to DeepSeek Harness `0.1.1-rc.2`, upstream commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e). It registers a Host-side `/leppy-loop` command, an always-discoverable grant-validated controller tool, a model-only `leppy-loop-operator` lifecycle skill that cannot collide with the human command, and browser cards without patching Harness.

## Install

Node `22.19+`, Git, and pnpm `10.28.1` are required. DeepSeek Harness forwards plugin management to the `pnpm` found on `PATH`; pnpm 11 requires a separate native-build approval step and is not claimed as an install-compatible combination for `0.3.22`. Configure the credential for the model provider selected in the Harness Models page, then build and install the tarball into the profile used by the Web host. Workers reuse that provider, model profile, and credential automatically; `DEEPSEEK_API_KEY` is not required when another provider is selected:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add ./leppy-loop-deepseek-0.3.22.tgz
```

Restart the existing `dsh web` process after changing its profile. A browser refresh cannot compose a newly installed Host plugin. A published GitHub Release tarball may replace the local `.tgz` path; there is no claim of publication in a plugin registry.

## Quickstart

Create and commit a tracked checklist such as [`examples/feature.task.md`](examples/feature.task.md), then invoke one lifecycle with ordinary human language — never paths, refs, run IDs, fingerprints, scopes, cycles, or repair flags:

```text
/leppy-loop
/leppy-loop finish the capability adoption and open a pull request
/leppy-loop run this locally; do not publish
/leppy-loop status
/leppy-loop stop
```

The slash command returns after minting one lifecycle permit and queues one short AI resolver turn. The same permit can drive up to sixteen sequential controller transitions for one session, canonical repository and run, so the AI can resume recoverable work, choose bounded gate repair, reconcile publication and react to background completion without asking the human for phase-specific slash commands. Exactly one transition may be in flight. Once bound, the permit uses an HMAC required-marker, chained receipts, and an authenticated monotonic head: admissions persist before job start, local-only downgrade before slash acknowledgment, and Stop revocation before kill. It rehydrates after a Host restart; corrupt modern authority is quarantined, mutable `run.json` is never authority, and consumed transitions cannot replay after a crash; it still expires after 24 hours, cannot cross sessions/repositories/runs, and cannot widen repair scope, merge or deploy. Explicit `do not publish`/local-only language irreversibly removes branch-push/PR authority from that lifecycle; otherwise `/leppy-loop` authorizes the AI to decide whether normal delivery includes the controller-owned branch and PR based on the conversation.

The globally discoverable `leppy_loop_control` tool receives technical checklist/base/run/recovery/publication facts while the human surface remains simple. Read-only `preflight` validates canonical scopes and the authoritative base before start. The tool binds an unbound permit to the first run exactly once, validates every continuation against the live HMAC-authenticated controller, uses cumulative transition budgets, and transfers each transition into owner-fenced `ctx.jobs`. `status` never trusts a remembered job ID and exposes durable controllers only to their signed owning session: a durable `running` state without an owner-fenced Host job is reported as `orphaned`. Gate fingerprints, clean-worktree checks, closure scope, receipts and bounded repair cycles remain controller-enforced; workers still cannot push or invoke `gh`.

The default `adaptive` worker policy uses `gpt-5.6-terra` at `high` for ordinary OpenAI Codex tasks, then `gpt-5.6-sol` at `low` for closures and recovery of a stalled task. Terminal SDK notifications for overload, temporary unavailability, rate limits and HTTP 502/503 remain availability failures even when the SDK resolves with an empty final response: they receive the availability fallback once and otherwise stall with a recovery receipt. They never enter zero-commit verification. A genuinely clean ordinary-task completion with zero commits is retried once automatically under the recovery policy. If that independent retry proves the `Done:` contract is already satisfied through the exact terminal evidence marker and leaves a clean unchanged branch, the controller closes only the checklist; dirty WIP, missing evidence, and an unverified repeated zero-commit result still fail closed. Inline `model=`/`effort=` metadata and CLI-only `--model`/`--effort` options take priority. Use `--worker-policy selected`, `terra-high`, or `sol-low` to choose another global behavior. The default transcript cap is 8192 KiB and remains configurable with `--worker-transcript-limit-kb`. Resume receipts include `--recover-run <id>` so recovery remains deterministic even when older failed runs still exist. Exact authenticated recovery resolves and lints the controller from the preserved run worktree, so a receiving source checkout may have switched branches, removed that checklist, or contain unrelated dirty changes; fresh runs still require a clean source checkout with a tracked checklist. A failed gate can reserve a retry or bounded repair transition from the same active lifecycle permit; the scoped tool reconstructs the exact authenticated run and the controller retries only the unchanged fingerprint. Repair refuses a dirty worktree, creates a controller reopen commit, stays within existing closure scope, and consumes the fixed lifecycle repair/transition budgets. When a failed gate proves the original closure omitted required generated artifacts or dependencies, a direct human may add existing worktree scopes with `--repair-path <path...>`; these additions are validated, persisted, receipted, and granted only to that reopened repair worker. Worker root commands may omit `cwd` or use `cwd="."`, while changed-file commit validation remains limited to the effective scope. A direct repair invocation chains up to three fresh closure/gate cycles by default, passing each newly failed receipt to the next worker; `--repair-cycles <1..8>` changes this hard bound. It stops immediately on success, worker failure, dirty state, changed fingerprint, cancellation, or exhaustion rather than looping indefinitely. The autonomous resolver must report a stalled/failed result and stop; it may never edit the preserved worktree, delegate a repair, publish, or integrate around the controller. Supplying an exact run ID may also continue a completed selective run on the next open checklist row in its preserved branch/worktree; completed runs are never chosen implicitly.

Every worker must end with one structured `LEPPY_OUTCOME`. `completed` requires concrete `validation.status=passed` evidence. Missing/malformed reports, `blocked`, failed validation, or contradictory terminal prose such as `BLOQUEADO` stall with the row open even if Git looks clean. Three identical failed tool calls or eight total failures stop the worker turn; blocked/unavailable/repeated failures also open a durable automatic-recovery circuit instead of burning lifecycle transitions. A deterministic npm `ENOTCACHED`/`only-if-cached` miss or `MODULE_NOT_FOUND` below `node_modules` stops after its first tool failure. The global attempt is persisted before every retry worker starts.

Before releasing a worker, the controller materializes a usable npm tree itself. It first prefers an equal, structurally current source `node_modules` as an explicit trusted-local-state boundary. If that copy is unavailable, one non-workspace npm lock whose packages are pinned to credential-free HTTPS origins and supported integrity digests may be installed with the Host's own `npm-cli.js` in private staging; `inBundle` children are accepted only through an explicit recursive declaration chain ending at such an integrity-pinned tarball. That `npm ci` receives isolated configs/cache, an allowlisted environment, no lifecycle scripts/audit/funding, live process-tree cancellation and file/byte/depth quotas. Both paths reject unexpected packages/shims/hidden payloads, external links and hardlinks, validate the complete tree, and normally publish without replacing or deleting a target. For an authenticated `ENOTCACHED` or missing-module condition, the repository-locked runner may atomically quarantine an invalid existing target, materialize the exact worktree lock, publish and validate a new physical tree, then discard the quarantine. A durable identity-bound transaction adopts only its post-validation `published` phase; earlier crash/failure phases preserve the original quarantine, remove only an identity-proven controller target and retry without ever restoring over, deleting or replacing an unowned race. A pending transaction receipt is independently fail-closed before worker release, and setup errors preserve the authenticated dependency-miss context needed to resume that same transaction. This repair requires the exact current error digest under the same persisted lifecycle authority before another worker starts.

Worker executable lookup prepends only the authenticated root `node_modules/.bin`, resolves the exact command through the Host subprocess service, and executes that resolved path with the same scrubbed environment inside a sandbox whose canonical root must equal the worktree. Package managers are fail-closed to explicit `run`/`test` scripts; dynamic frontends (`npx`, `bunx`, `pnpx`, `yarnpkg`, `corepack`), dependency mutation and project-local cache overrides are denied. Workers otherwise invoke already-materialized tools by bare name. If an authenticated prior `npx` failure left a wholly untracked physical `.npm-cache` outside task scope, the repository-locked controller may move that directory—without deleting its bytes—into an HMAC-authenticated identity-bound quarantine transaction before resuming preserved task WIP. New attempts require a signed pre-worker absence baseline; legacy runs require the exact current failure digest and exact run ID. Tracked, staged, linked, ambiguous, recreated or identity-changed cache state stalls closed; cross-device artifact state is rejected before a receipt exists. Every receipt phase is reconciled before worker release, and a crash resumes the same transaction.

While a Web run is active, every selected row creates one durable progress card. `Running`, per-task attempt, and elapsed time use separate non-shrinking elements while only the long task label elides; terminal output settles the same card. Sequential rows and durable split replacement rows each begin at `Attempt 1`, while explicit recovery of the same unchanged row advances its local ordinal. The separate global attempt identity remains cumulative for leases, receipts, events, and bounded lifecycle recovery. A recovered interrupted row starts a new attempt card. The controller itself appears as a background card with status, elapsed time, and a Stop button. `/leppy-loop status` reports the exact owner-fenced active job first; a controller whose durable state says `running` without such a job is explicitly `orphaned`, never assigned a guessed `leppy-loop-*` ID. Otherwise it reports the newest authenticated controller regardless of whether work or publication stalled. Resolved stalls retain their bounded actionable detail instead of degrading to a generic failure. Browser timers write no per-second events or model tokens.

Publication first derives one exact GitHub repository from matching fetch/push URLs and reconciles an exact same-owner OPEN or MERGED PR before any rebase, gate or push; MERGED reconciliation may perform a read-only fetch to prove its merge commit remains in the live requested base. Otherwise it prunes and queries live remote refs instead of trusting stale tracking branches. A deleted configured base fails closed; the AI may provide a technical replacement branch only inside the same lifecycle, never a different remote, and the controller accepts it only when a durable prior target commit is incorporated into the live replacement. OPEN and MERGED PR reconciliation applies the same base/ancestry rule. All fetch, `ls-remote` and push operations use the validated literal URLs rather than a mutable remote alias. An already-pushed controller branch is updated only with an exact observed-OID `force-with-lease`; base OID, remote head, clean worktree and gate-validated HEAD are rechecked immediately before push and the remote head is verified afterward. PR lookup runs again before create to absorb races.

If the exact-OID rebase stops on conflicts, at most three fresh recovery workers receive exact-path read/write/delete access only to unmerged files, without commit or exec tools. The controller freezes HEAD and the complete Git index, rejects drift or out-of-scope edits, stages resolved conflicts itself, safely skips empty replay steps, and reruns the final gate. Existing exact PR reconciliation performs no remote mutation and lets a prior manual/open/merged PR settle durable Leppy state. Workers cannot push or use `gh`; Leppy never merges or deploys. Install and authenticate GitHub CLI first (`gh auth status`) before allowing publication.

## Checklist contract

```md
## API phase

- [ ] Add `src/api.ts` | Done: GET /health returns 200 | model=deepseek-v4-pro | effort=high
- [ ] Update docs | Done: README documents /health | paths=README.md
- [?] Closure: inspect API phase | paths=src,README.md
- [~] Gate: focused project gate
```

Marks and line types:

| Mark | Meaning |
|---|---|
| `[ ]` | open ordinary worker task |
| `[?]` | open phase closure worker |
| `[~]` | open controller-only phase gate |
| `[x]` | completed line of any type |

Ordinary tasks require a non-empty `Done:` and explicit canonical repo-relative write paths, preferably through `paths=a,b` (path-shaped backtick spans remain a compatibility fallback). Extension-only fragments such as `.ui`, brace/glob syntax, inferred nested basenames without their full path, and test-requiring rows without a test-capable scope fail preflight. The canonical pipe format is preferred, but indented Markdown continuations and the historical `[closure]`/`[gate]`, `Paths:`, `Paths EXATOS:`, `Paths permitidos:` and multiline `Done:` forms are accepted. A `[?] [human]` or `[?] [human/live]` checkpoint is never sent to a worker: the run stalls with its preserved worktree until a human marks that row complete and recovers the exact run. The commit capability stages the exact validated changed files; an ignored untracked file is eligible only when it sits beneath one of those explicit scopes, allowing intentionally versioned migrations without sweeping unrelated ignored material. `--task-match` is a literal substring, not a regular expression. A phase may omit closure, gate, or both; when both exist they must be adjacent and final among automated rows. Markdown outside checkbox markers is preserved byte-for-byte except for the file's existing newline convention.

A tracked root `.leppy-loop.json` may contain a string `customInstructions`; it is appended to the applicable `AGENTS.md`/`CLAUDE.md` instructions for every worker. Invalid shapes fail closed, the file is capped at 64 KiB, and the instruction string at 32 KiB. Dry-run results include all lint diagnostics through both the model-facing tool and direct command text.

Paths are resolved through filesystem identity. Traversal, absolute paths, and symlinks/junctions escaping the worktree are rejected. The controlling checklist is always denied to workers.

## CLI startup options

These technical arguments are for the separately exported CLI startup composition, not the human Web slash interface.

| Option | Default |
|---|---:|
| `--sync-max-seconds` | 120 |
| `--worker-timeout` | 30 minutes |
| `--max-iterations` | 64 |
| `--worker-output-limit-kb` | 192 KiB |
| `--worker-transcript-limit-kb` | 8192 KiB |
| `--fetch` / `--no-fetch` | fetch once |
| `--task-match <literal>` | first open line |
| `--recover-existing-wip` | disabled |
| `--provider`, `--model`, `--effort` | Harness current selection |
| `--fallback-model` | none |
| `--artifacts-dir` | `<git-common-dir>/leppy-loop/runs` |

Models are strictly checked against `ctx.llm.listModels(provider)`. Effort is checked against the exact model metadata returned by `ctx.llm.resolveModelInfo`. A fallback is attempted at most once and only for classified availability/rate-limit failures.

## Execution semantics

1. The source checkout and tracked checklist must be clean.
2. The controller optionally fetches once, resolves `--sync-branch` as the authoritative base, creates `leppy-loop/<tasks>-<run-id>`, and creates one sibling worktree. It never syncs again during the run.
3. Each ordinary line gets a new worker process and SDK session. It must report structured passed validation, leave exactly one conventional commit and a clean tree. The controller then changes its checkbox to `[x]` and amends that commit.
4. Closure gets a new worker and must report structured passed validation; it may leave one corrective conventional commit or a validated clean no-op. Blocked/failed closures remain open.
5. Gate has no worker. The controller executes the opaque command once through the platform shell, writes a receipt, marks the line, and commits both. Failure or interruption is never retried automatically.

Leppy differs from a generic Ralph loop by making a repository checklist the controller-owned state machine. Ralph commonly repeats an objective until a worker reports completion; Leppy selects one typed line, gives it bounded path scope, validates its Git effect, and makes closure/gate explicit phase transitions.

## Events

`events.jsonl` uses the versioned envelope:

```json
{"schemaVersion":1,"type":"start","runId":"...","timestamp":"...","phase":"worker","taskIndex":0,"attempt":1,"data":{}}
```

The event type union is exactly:

`run-start`, `start`, `done`, `recovery-start`, `recovery-done`, `gate-start`, `gate-end`, `stall`, `timeout`, `gate-failed`, `run-end`.

The package exports `runLeppyLoop`, `executeLeppyLoopCommand`, `parseLeppyLoopCommandInput`, `parseChecklist`, `lintChecklist`, `HarnessWorkerAdapter`, `LeppyLoopOptions`, `RunResult`, `RunPreview`, and `RunEvent`.

## Recovery

Durable state lives outside the worktree: `run.json`, `runner.pid`, `events.jsonl`, outputs, transcripts, receipts, diff summaries, `resume.json`, the ownership proof, and HMAC worker leases. A lock under `git-common-dir` prevents concurrent loops for the same repository.

On timeout, output limit, transcript limit, or interruption, WIP and the current open line are preserved. Resume with the original arguments plus:

```sh
--recover-existing-wip
```

Recovery adopts only one matching run whose ownership HMAC, branch, and worktree still match. A live worker is terminated only when its signed lease, PID, and process-start identity all match. No process is searched or killed by name.

## Authentication and secrets

The bundle resolves `DEEPSEEK_API_KEY` from the Harness credential service and supplies it only to the model runtime environment. Tool subprocesses receive a credential-scrubbed environment. Events, outputs, transcripts, errors, headers, and credential-bearing URLs pass through recursive redaction.

## Security boundary

This is practical isolation, not a network sandbox. Ordinary workers may read real paths inside the worktree except the controller, but writes remain scoped. `leppy_search` and `leppy_edit` replace shell search/patch loops. Exact argv commands use the official `workspace-write` sandbox; PowerShell is allowed only as `-File` for a repo-local `.ps1`. Git is a positive read-only verb allowlist, while remote clients, publication, deploy, PR mutation, branch integration, worktree management, dynamic evaluation, and the phase gate fingerprint are denied.

Git worktree commits necessarily update `git-common-dir`, which is outside the worktree sandbox root. Therefore commits use a separate narrow `leppy_commit` capability: it accepts only a conventional message, verifies every changed path is in task scope, stages only those scopes, and invokes exact Git argv. It does not expose general access to Git metadata.

The official sandbox does not confine network access. A malicious repository script already allowed as a focal test can still use network or perform behavior permitted by the OS account. Do not run Leppy Loop on untrusted repositories. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Costs and limitations

Each line starts an independent context, so shared conversational cache is intentionally lost and model cost may be higher. Version `0.3.22` supports only the tested Harness pin. Network confinement, automatic push, PR mutation, release publication, package publication, and deployment are not provided. No remote action is automatic.

## Uninstall

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web remove leppy-loop-deepseek
```

Restart the Web host after removal. Remove a dedicated CLI profile separately if you created one. Worktrees and preserved WIP are never deleted automatically.

## Troubleshooting

- **Source checkout must be clean**: commit or move your WIP; Leppy refuses to guess ownership.
- **Model absent from catalog**: use `--dry-run`, then choose a model returned by the configured provider.
- **Sandbox unavailable**: install/repair the platform backend supported by Harness. The worker fails closed.
- **Gate remains open after failure**: fix the failure and invoke the command again explicitly; recovery does not replay gates.
- **Recovery is ambiguous**: inspect the state directories and choose manually. Leppy will not adopt unprovable WIP.
- **Commit rejected**: changed files escaped the declared task paths, the checklist changed, the message was not conventional, or the tree was not clean.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm secret:scan
```

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

## License

Apache-2.0.
