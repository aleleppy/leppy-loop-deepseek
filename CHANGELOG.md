# Changelog

All notable changes are documented here.

## [0.3.43] - 2026-08-31

### Fixed

- Every deliberate stalled result now persists and returns an authenticated `detail`, including gate exit evidence, missing gate-retry authorization, human checkpoints, and iteration exhaustion. Successful gate recovery clears stale detail.
- A failed gate with a completed adjacent closure now automatically reopens that closure and runs bounded fresh repair workers inside the same controller job. It stops only after the configured repair-cycle limit, while gate-only checklists still require explicit retry authorization.

## [0.3.42] - 2026-08-31

### Changed

- Explicit local-only `continue` (`publish: false`) may reuse the same session-bound, bounded persisted lifecycle authority even when the unchanged-failure circuit is open. Publication-capable recovery still requires fresh human reauthorization, and transition/iteration limits remain enforced.

## [0.3.41] - 2026-08-31

### Fixed

- Ordinary command observation now reports tool `exitCode: 0` plus the real `commandExitCode` and `advisory` flag, so Harness tool-failure budgets do not misclassify expected validation failures. Workers are told not to repeat unchanged nonzero commands and to run `npm run prepare` once when Svelte diagnostics specifically lack `.svelte-kit/tsconfig.json`.

## [0.3.40] - 2026-08-31

### Fixed

- The controller now discards a proven wholly-untracked root `.svelte-check` cache after every task, closure, and disposable verification worker. Clean closures no longer stall merely because validation generated a manifest without requiring a commit. Dependency-bridge instructions also follow advisory validation semantics instead of telling workers to block on unavailable tooling.

## [0.3.39] - 2026-08-31

### Changed

- Ordinary `leppy_exec` validation failures return structured exit code/stdout/stderr evidence instead of consuming the worker tool-error budget. Windows `spawn EPERM` and task-mode Playwright named-pipe unavailability are likewise advisory results; verification remains strict and security/argument/scope failures still reject the call.

## [0.3.38] - 2026-08-31

### Changed

- Ordinary task and closure validation is advisory. Workers must attempt checks and report exact failures, but may complete and commit when engineering judgment says the Done contract is satisfied despite unavailable tooling, sandbox limitations, or unrelated baseline failures. Verification and publication-conflict workers remain strict.

## [0.3.37] - 2026-08-31

### Fixed

- Task commits discard an untracked root `.svelte-check` validation cache after proving it contains no tracked paths and cannot escape the worktree. Generated manifests no longer consume tool failures or enter scoped commits.

## [0.3.36] - 2026-08-31

### Fixed

- The lock-protected dependency hydration recheck now accepts the same exact invalid-tree state admitted by the controller, allowing authenticated replacement to proceed instead of stalling before publication.

## [0.3.35] - 2026-08-31

### Fixed

- A stalled run whose existing worktree dependency tree no longer matches its authenticated npm lock is now classified as an exact dependency-repair transition. Resume can quarantine that owned invalid tree and publish a freshly verified physical tree before releasing another worker.

## [0.3.34] - 2026-08-31

### Fixed

- Legacy ignored-baseline recovery now skips optional ordinary-untracked subset inference when more than 128 paths are present. Authenticated ignored/tracked evidence must still prove the baseline digest, so wide generated workspaces no longer stall fresh runs while unprovable recovery remains fail-closed.

## [0.3.33] - 2026-08-31

### Fixed

- Windows task workers now classify Playwright's intentional nested named-pipe denial once, preserve the attempted argv and commit, and hand one authenticated clean candidate to the existing detached verifier instead of retrying executable or stdio variants. A completed report with failed validation is normalized to failure before state settlement and cannot become pending validation after restart. New active attempts persist an HMAC-bound terminal disposition synchronously; same-process and restart recovery promote only `validation-unavailable`, while failed/missing schema-v2 receipts stall closed, authenticated discovery accepts schema-v2, every retry replaces its receipt, and schema-v1 preserves bounded existing-run compatibility.
- Detached verification can opt into an exact-`repoRoot` WSL2 + bubblewrap executor with no Host-unconfined fallback. The executor proves candidate root plus the authenticated pending commit OID and archives that exact object, scrubs Host credentials/`WSLENV`, resolves staging through the selected distro's `wslpath`, authenticates the live mount table and constructs a minimal read-only distro runtime with WSL submounts masked and arbitrary mounts, homes, mutable state and WSL interop absent, uses private writable workspace/home/temp/cache under a read-only distro root, denies interactive/discovery/snapshot-mutation modes, and separates outer/bootstrap infrastructure from candidate npm setup/prepare/test failure through a Host-only phase receipt. `npm ci --ignore-scripts` installs dependencies; canonical-registry lock/package/dependency edges and the direct launcher are authenticated before the tree becomes read-only except exact private Vite cache overlays.
- Host-local environment and generated baseline authority is bounded and fail-closed: env files are physically contained private regular files read through stable handles; allowlisted values are redacted before bounded output retention; seed leaves must be ignored by tracked `.gitignore` authority and untracked in both roots, reject source links/special files/mutation races plus candidate non-directory destination ancestors, and emit a stable SHA-256 receipt. Bounded explicit `playwrightConfig` removes the TypeScript-config assumption when timeout wrapping is requested. Cancellation preserves the exact abort reason, checks `taskkill` completion/nonzero fallback, terminates the Windows/WSL process tree and waits for teardown.
- Fresh-run source preflight permits only the exact bounded untracked Host-local profile while continuing to reject every unrelated WIP entry; tracked/malformed linked/oversized local authority remains fail-closed. the gate requires a committed clean source, `prepack` rebuilds ignored runtime artifacts, `prepublishOnly` runs the canonical gate, install smoke imports the shipped worker/WSL modules, and the provisioned Windows lane includes the real WSL capsule boundary. Regression coverage includes snapshot equals-form denial, tracked overlay rejection, hardlink/junction confinement, chunk/cap-boundary secret redaction, contradictory-validation restart, first-failure circuit status, and a mandatory supported-Windows real Chromium/lifecycle-disabled/read-only-launcher/outer-infra/genuine-failure/synchronized-cancellation integration target. The supported target repo reached browser `globalSetup`; its remaining `ECONNREFUSED 127.0.0.1:3000` was independently confirmed as an absent external backend listener.

## [0.3.32] - 2026-08-31

### Fixed

- The exact `0.3.31` tracked-and-untracked base-ignore terminal receives one last persisted-authority capability transition that may use every current ordinary untracked path solely as an exact historical-baseline candidate. This covers a baseline ignored at dispatch by mutable repository-local or global excludes that no longer classify it today.
- The authenticated ordered-fingerprint SHA-256 remains the only baseline authority. Candidate enumeration is capped, canonical and deduplicated; one shared 512 MiB content budget spans ignored, tracked and ordinary classes per collection; and a second complete ordinary/ignored/tracked snapshot must remain stable before persistence. Base `.gitignore` classification runs in a fresh isolated Git dir with empty repository/global/system excludes, so mutable `.git/info/exclude` and `core.excludesFile` cannot authorize quarantine.
- Ordinary untracked candidates outside the proven baseline are never classified as worker output and never enter quarantine unless the immutable base `.gitignore` rules independently authenticate them. Preserved baseline and unproven ordinary WIP therefore remain in place and the existing clean-tree gate blocks adoption and verifier release. Only the exact `0.3.31` tracked-and-untracked terminal can authorize this transition; older terminals cannot skip capability stages, and the new baseline-only terminal cannot authorize itself.
- Regressions reproduce a removed `.git/info/exclude` rule, reprove the exact baseline, quarantine only a currently ignored generated file, preserve unrelated ordinary WIP, and reject dirty candidate adoption with zero verifier calls.

## [0.3.31] - 2026-08-31

### Fixed

- The exact `0.3.30` base-ignore terminal receives one final persisted-authority capability transition for paths that became tracked since the authenticated active-attempt base but are no longer ignored by current rules. Promotion discovery disables rename detection so an exact ignored preimage promoted as a tracked rename destination is still represented as Added, and accepts only paths ignored either now or under the byte-exact regular `.gitignore` rules from the immutable base.
- Current bytes, type and path must still reconstruct the authenticated ordered-fingerprint SHA-256 digest exactly. Candidate discovery and a second stable snapshot repeat current/base ignore classification under the existing path/file/byte budgets before an inferred receipt; resumed attempts revalidate inferred fingerprints and filesystem identity.
- Every legacy ignored-baseline capability transition now uses a two-phase admission. The command binds the normalized exact terminal and full active-attempt identity into an idempotent `prepared` marker, acquires the repository lock, reparses and HMAC-verifies current state, then atomically embeds that marker before lifecycle/job admission. The preparation also binds a digest of the normalized technical request and its target lifecycle epoch/transition: persistence failure retries the same target, while a persisted receipt followed by job-registration failure reuses that exact admission without incrementing the transition budget, including the final allowed transition. The runner requires the exact option and prepared marker, then HMAC-promotes it to `consumed` under the repository lock before reconciliation; only consumed state blocks replay.
- Regression coverage promotes an ignored pre-existing file while narrowing `.gitignore` and deleting an identical tracked source, forcing Git rename detection without `--no-renames`. The integrated runner case proves the de-ignored tracked baseline is preserved, four generated outputs are quarantined, the committed candidate becomes clean, and exactly one isolated verifier is released.

## [0.3.30] - 2026-08-31

### Fixed

- The exact `0.3.29` promotion-aware terminal receives one persisted-authority capability transition that also evaluates current ordinary untracked paths against regular `.gitignore` blobs from the authenticated active-attempt base. Only paths that were ignored under those immutable base rules enter the exact bounded fingerprint set; the historical SHA-256 digest remains the sole baseline authority. Generated base-ignored ordinary files join the existing signed quarantine transaction, while an unchanged de-ignored baseline path is preserved and still prevents candidate adoption as dirty WIP.
- Base ignore reconstruction preserves Git mode, type, object identity, pathname and blob bytes. Only regular `100644`/`100755` blobs are materialized; symlink/gitlink entries are skipped, checkout-transforming filter/encoding/ident attributes reject recovery, and authority-bearing `-z` protocols use binary output with strict UTF-8 round-trip. Literal POSIX backslashes are preserved, Windows-noncanonical backslashes reject, invalid bytes never become replacement-character rules, and scratch index/worktree cleanup is unconditional.
- Candidate and ignore sources are capped at 128 paths/files, base rules at 1 MiB, and file content at independently streamed 512 MiB budgets. Reconciliation, resumed preflight, immediate pre-move and final quarantine validation all stream exact fingerprints and retain growth, byte-count, identity, hardlink and same-device checks.
- Regressions cover unchanged and changed de-ignored baselines, mixed ignored/ordinary generated-output quarantine, dirty-WIP adoption refusal, symlink `.gitignore`, checkout filters, invalid UTF-8 blob bytes versus a real replacement-character filename, and literal POSIX backslashes. The new base-ignore terminal is versioned and cannot replay its own anti-thrash bridge.

## [0.3.29] - 2026-08-31

### Fixed

- Legacy ignored-baseline inference now augments current ignored fingerprints only with exact paths that became Git additions since the authenticated active-attempt `baseHead` and remain ignored under `git check-ignore --no-index`. Current bytes/type/path must reconstruct the authenticated SHA-256 baseline digest exactly; ordinary tracked additions are excluded. A second full ignored-plus-promotion snapshot must remain identical before the signed inferred receipt, and post-receipt retries revalidate inferred tracked promotions by fingerprint and filesystem identity.
- The exact predecessor four-addition terminal receives one persisted-authority capability transition only when its canonical candidate count equals a complete one-through-four removal total for 0..39 entries. Leading-zero, unsafe, impossible, current promotion-aware, prefixed and suffixed diagnostics remain rejected. New no-match errors identify promotion-aware inference and cannot replay this bridge.
- Promotion discovery is capped at 128 added paths. Promoted file content is capped independently at 512 MiB per snapshot/retry and hashed as a stream after metadata preflight, with growth and exact byte-count checks. Oversized, mutated, raced, ordinary tracked, hardlinked or unmatched state fails before a baseline receipt, recovery transaction, quarantine move or verifier.
- Regression coverage reproduces the live two-fingerprint/three-candidate predecessor condition, exact unchanged force-add promotion plus four generated ignored outputs, modern-versus-legacy promotion policy, ordinary tracked filtering, mutation and identity races, crash after inferred receipt, and sparse oversized files. The runner quarantines only digest-proven generated outputs before releasing one isolated verifier.

## [0.3.28] - 2026-08-31

### Fixed

- Existing-run lifecycle resolver instructions now require `operation=status` as the first tool call in every turn, then permit at most one transition from the exact returned controller facts when no live owner-fenced job exists. The bundled operator skill carries the same rule. Read-only status remains available while the anti-thrash circuit is open and returns before lifecycle permit hydration or reservation.
- The two superseded ignored-baseline capability conditions now normalize only leading and trailing whitespace before full literal equality and require an authenticated active task attempt before bypassing anti-thrash. Prefixes, suffixes, current bounded-search diagnostics, unrelated failures, and exact legacy text without active attempt remain rejected. Regression coverage uses stale durable authority—not the fresh-reauthorization bypass—to perform status, Host-memory-empty hydration, and continuation for the exact, missing-manifest, and CRLF/tab-boundary variants.
- A rejected unchanged continuation reports only a 64-bit SHA-256 condition identifier, UTF-8 byte count, and active-attempt presence so a deployed mismatch is diagnosable without exposing paths, fingerprints, content, or the baseline digest. Foreign-session lifecycle ownership is rejected before these diagnostics are constructed.

## [0.3.27] - 2026-08-31

### Fixed

- The exact `0.3.26` terminal legacy-baseline inference failure receives one capability-changed continuation under its already persisted lifecycle authority. Because that predecessor could emit the terminal no-match detail only after exhausting removals one through three within 10,000 candidates, it proves a maximum of 39 current fingerprints. The migration therefore exhaustively tests a fourth removal only inside that authenticated envelope: 92,170 total candidates at 39 entries, below its 100,000 cap. Wider snapshots retain the predecessor's three-removal/10,000-candidate bounds, and prefixed, suffixed, current, or unrelated errors cannot use the bridge.
- Legacy subset work is now also bounded by actual UTF-8 volume: current fingerprints may total at most 128 KiB and candidate serialization/hashing aborts above 512 MiB cumulatively. Search still yields every 128 candidates. Any limit, mismatch, changed baseline, identity race, or no-match result remains fail-closed before a baseline receipt, recovery transaction, quarantine move, verifier, or worker starts.
- Regressions exercise four generated ignored outputs through unit and committed-candidate recovery, preserve pre-existing ignored WIP, quarantine only the exact digest-proven complement, and release only the isolated verifier. Boundary tests enumerate the full 39-entry predecessor envelope, retain the old cap at 40 entries, and assert neither failure creates baseline or recovery receipts.

## [0.3.26] - 2026-08-30

### Fixed

- A fresh direct-human `/leppy-loop` reauthorization can now open a new sixteen-transition budget epoch for the exact same-session, same-repository, same-run controller only after its preceding epoch is fully exhausted. The epoch is part of every authenticated admission, cannot skip, inherit prior consumption, widen publication, cross a revocation, or reset automatically. Reauthorization uses a serialized prepare/persist/commit transaction; failed persistence leaves Host memory unchanged, while a higher durable epoch supersedes stale pre-crash memory.
- Lifecycle authority rollback protection now extends beyond the replaceable run bundle. Each fully validated local chain advances an HMAC-authenticated, append-only, create-exclusive high-water anchor per run and sequence under Host-owned `DSH_HOME`; coordinated restoration of an old local head and receipt prefix therefore fails closed. Receipt persistence precedes head replacement, one exact authenticated tail can finish after a crash, and a missing mature head is reconstructed only from a pre-existing exact external anchor. Read-only inspection cannot create the trust evidence it requires.
- Exhausted orphan recovery distinguishes stale durable `running` state from actual activity. Budget rollover rejects a live owner-fenced Host job, acquires the authenticated repository lock, and waits for definitive signed lease settlement before persisting the next epoch. Repository-lock producers and reclaimers now use the same tri-state OS identity rules as worker leases; inspection errors fail closed and no approximate wall-clock identity is synthesized.
- Regression coverage includes slash→epoch 2/0→control 2/1→runner propagation, Host restart at the zero-consumption tail, stale-circuit rejection, persistence rollback and concurrent slash serialization, orphan/live-lock behavior, stale-RAM adoption, premature/skipped/inherited epochs, receipt-before-head crash recovery, cross-prefix rollback, same-sequence anchor forks, mature-head reconstruction, and repeated headless inspection with no trust-on-first-use side effect.

## [0.3.25] - 2026-08-30

### Fixed

- Legacy active attempts whose authenticated ignored baseline digest is non-empty can now recover only when a bounded search finds an exact ordered subset of the current path/content fingerprints whose SHA-256 equals that digest. The inferred baseline is stable-preflighted before persistence, safely re-inferred after a pre-transaction crash/race, capped at 128 entries, three additions, 10,000 candidates and 128 Ki fingerprint text, and yields the event loop every 128 candidates. Changed/missing baseline WIP, tracked legacy promotion, oversized or unmatched state still fail closed; only the proven complement enters the existing authenticated quarantine transaction.
- Recovery no longer terminates a worker by reusable PID. Under the repository lock it polls a tri-state OS process identity and advances only after definitive absence or a positively different start identity; persistent workers and inspection failures stop before run-state, receipt, quarantine, verifier or worker mutation. Worker hosts must obtain a real OS identity before creating Context or spawning a child and never synthesize a wall-clock fallback lease identity.
- The exact authenticated pre-subset failure receives one capability-changed continuation through existing persisted lifecycle authority, so installing this release does not require another direct-human transition solely to exercise the newly available safe migration. Prefix, suffix and unrelated worker diagnostics cannot use that bridge. Regression coverage includes committed candidate verification with a preserved non-empty ignored baseline, lease survivor/PID reuse/inspection failure, producer identity failure, inference races before and after persistence, combinatorial bounds and exact authority matching.

## [0.3.24] - 2026-08-30

### Fixed

- Every ordinary worker dispatch now records an immutable HMAC-authenticated ignored-path baseline bound to run, task and attempt before persisting active-attempt authority. Post-worker reconciliation classifies the complete delta before mutation: unchanged pre-existing ignored WIP is preserved, changed/replaced/deleted WIP fails closed with zero moves, a baseline path promoted into the authorized tracked commit is accepted, and only baseline-absent regular-file leaves may enter private quarantine. Legacy active attempts can synthesize a baseline only when their authenticated digest is the canonical empty-set digest.
- Ignored-artifact quarantine uses a signed deterministic transaction receipt whose reference is embedded in authenticated active state before the first rename. Recovery revalidates the physical private root, parent identity, source fingerprint, link count, same-device constraint, and all source/destination states before any move; symlink/junction escape, hardlinks, special files, cross-device state, tracked promotion after preparation, source reappearance, missing/tampered receipts and ambiguous partial states all fail closed. Prepared and partially moved crashes resume the exact transaction and preserve artifact bytes.
- Availability and clean no-commit retries now record a fresh baseline for the new attempt and clear the preceding transaction reference. Regression coverage includes the production legacy-empty active recovery, candidate adoption after safe quarantine, pre-existing ignored WIP, retry baselines, tracked promotion, prepared/per-entry crashes, receipt deletion/tamper, multi-entry all-or-nothing replay, source reappearance, junction escape and hardlink rejection.

## [0.3.23] - 2026-08-30

### Fixed

- Material task progress is authenticated before worker admission and survives blocked validation, interruption, and Host loss. A clean exact-scope single commit whose validation did not fail becomes `pendingTaskValidation` instead of being classified as unchanged or sent to another writable implementation worker. Task, checklist, base/candidate HEAD, ignored-byte digest, attempt, failure signature, verifier count, and adoption phase are covered by the run-state HMAC and revalidated under the repository lock.
- Pending commits are validated by a dedicated isolated worker mode with read/search/exec but no write/edit/commit/delete tools. Verification denies package managers, repository scripts, shells and interpreter frontends; only an authenticated bare binary from root `node_modules/.bin` may execute. It runs in a detached disposable worktree pinned to the candidate, then proves unchanged detached HEAD, index, tracked/untracked tree and unchanged durable WIP before trusting a passed report. Dependencies and ignored validator artifacts disappear with that worktree. Genuine validation failure never enters this path; unavailable or repeated verification remains fail-closed.
- Successful verification embeds a validated adoption receipt atomically inside `run.json` before the controller marks the checklist. Recovery reconciles crashes before write, after checklist write/stage, and after amend, accepting only the exact checklist-only rewrite and recording completion once. Missing-directory Git worktree registrations and exact private partial targets created before Git registration are reconciled without global prune. Legacy proof migration publishes the required marker, a full sanitized target proof, and embedded state in a resumable order so no crash can downgrade modern state back to legacy authentication. Durable task ignored paths and bytes are HMAC-bound, while a newly generated physical `.npm-cache` is automatically moved with its bytes into the existing authenticated private quarantine transaction. Human status exposes the pending commit, phase, and verifier-attempt count.
- Regression coverage now includes committed blocked/not-run verification, verifier tracked and ignored mutation, package/interpreter denial, interrupted-after-commit recovery, ignored out-of-scope task effects, automatic ignored cache quarantine, active/pending/state-proof tamper, atomic embedded proof without `ownership.hmac`, checklist pre-amend crash states, missing verification-worktree registration, exact candidate/checklist tamper, and unchanged-circuit denial.

## [0.3.22] - 2026-08-30

### Fixed

- Recovery now reconciles an authenticated `run.json` lifecycle identity through the complete HMAC-validated authority chain while holding the repository lock. This covers the real command handoff where direct-human renewal and the next admitted transition are both durable before the controller job reads the older run state. After waiting for the lock, recovery rereads and reauthenticates the exact current run state so a queued controller cannot overwrite newer progress with a pre-lock snapshot. That locked-fresh state must appear exactly in the validated chain; only then is it advanced to the authenticated tail and matched against the controller options, preserving WIP and releasing no worker on mismatch.
- Privileged actions now share a lifecycle-authority mutex with direct-human receipt persistence. Every worker release revalidates the exact authenticated tail, and every `git push`/`gh pr create` mutation is revalidated while holding that mutex; revocation aborts and publication downgrade removes publication authority instead of racing stale controller options.
- Regression coverage now includes a 31-case renewal/authority matrix, an end-to-end runner case for old run state → renewal receipt → transition receipt → one recovery, queued-recovery freshness, post-inspection revoke/downgrade races, and the npm-cache quarantine crash/reappearance suite.

## [0.3.21] - 2026-08-30

### Fixed

- The authenticated lifecycle receipt chain now represents one direct-human permit renewal as a monotonic successor: session and budgets stay immutable, consumed transitions do not reset, publication can only downgrade, and `issuedAt`/`expiresAt` must both advance with the exact same bounded TTL. This lets `/leppy-loop continuar` persist the `0.3.20` renewal instead of rejecting it as changed immutable facts, while model hydration still rejects expired authority.

## [0.3.20] - 2026-08-30

### Fixed

- A fresh direct-human `/leppy-loop continuar` command now renews an expired same-session durable lifecycle permit instead of being rejected by the stale expiry. Reauthorization preserves the consumed transition count and immutable publication downgrade, mints a new bounded TTL, and persists that renewed authority before enqueueing the controller follow-up, so a Host restart cannot lose the renewal.

## [0.3.19] - 2026-08-30

### Fixed

- Worker argv now resolves bare executables local-first from the authenticated root `node_modules/.bin` through the Host subprocess resolver, then confines and spawns the exact resolved path with the same scrubbed environment. The sandbox's canonical write root must equal the run worktree. Windows launch suffixes no longer bypass command policy. Package managers are fail-closed to explicit `run`/`test` script commands; `npx`, `bunx`, `pnpx`, `yarnpkg`, `corepack`, dynamic execution, dependency mutation and project-local cache overrides fail before resolution or spawn.
- Recovery of an exact authenticated `npx`/`leppy_commit` stall may move a wholly untracked physical `.npm-cache` out of the worktree into a private HMAC-authenticated, identity-bound quarantine transaction under the repository lock. New attempts require a signed pre-worker absence baseline; legacy runs require the exact current failure digest and exact run ID. The cache bytes and task WIP are preserved; tracked, staged, linked, ambiguous, recreated or identity-changed targets fail closed, cross-device state is rejected before a receipt exists, every receipt phase is reconciled before worker release, and a crash after receipt or atomic rename resumes the same transaction.

## [0.3.18] - 2026-08-30

### Fixed

- Exact-digest dependency recovery can now repair an invalid existing worktree `node_modules` instead of stalling forever. Under the repository lock, the runner renames only that exact target into private quarantine, materializes and validates the authenticated npm lock in isolation, publishes without replacement, and releases a worker only after a durable `published` receipt records the validated physical tree. `prepared`, `quarantined`, or `publishing` crash states are never adopted: identity-proven partial targets are moved aside and deleted while the original quarantine is preserved for the same transaction's retry. A pending receipt remains a pre-worker readiness condition even when npm setup wraps the original error; the current authenticated dependency-miss detail is preserved so the same transaction can be resumed. An unowned target race is never deleted or replaced. Without the current authenticated dependency-error digest, the existing tree remains untouched.

## [0.3.17] - 2026-08-30

### Fixed

- Persisted lifecycle recovery now forwards the authenticated digest for a recognized `ENOTCACHED` or `MODULE_NOT_FOUND` dependency miss even when the unlocked filesystem hydration probe cannot yet prove a copyable/installable tree. The repository-locked runner remains the authority: it revalidates that exact wrapped error digest, materializes and publishes a new isolated tree, and still releases no worker for `local` or unavailable dependencies. This removes the recovery deadlock where provisioning required a digest that command admission withheld until after provisioning was already possible.

## [0.3.16] - 2026-08-29

### Fixed

- npm lock validation now recognizes `inBundle` package entries only when each child is explicitly named by its lock-recorded bundle parent and that recursive authority chain terminates at a credential-free HTTPS tarball with a supported integrity digest. This allows real npm locks such as Tailwind's integrity-covered WASM bundle to be materialized without weakening origin checks.
- A prior `ENOTCACHED` or `MODULE_NOT_FOUND` dependency error is itself a pre-worker readiness requirement. The runner no longer depends on a legacy `dependencyBridgeActive` flag to fail closed, and a structurally `local` tree is not accepted as proof of repair: recovery requires the authenticated digest plus a newly published `copied` tree before another worker can start.
- Dependency quota and payload validation now use bounded concurrent traversal instead of serially reopening every path. npm-installed trees retain receipt/package/shim/link/hardlink/count/byte/depth checks while npm's lock integrity remains the byte authority; trusted source copies still compare complete SHA-256 manifests. An isolated production smoke materialized the current 1,120-package rep-front lock in 2m49s instead of timing out after ten minutes.

## [0.3.15] - 2026-08-29

### Fixed

- The controller no longer releases a worker when an npm worktree lacks its dependency tree. It copies a validated exact-lock source tree when available or materializes an integrity-pinned HTTPS npm lock itself in private staging, then validates and publishes the result before worker startup. A previously activated dependency bridge whose tree disappeared now fails closed during setup or recovers the exact authenticated `MODULE_NOT_FOUND` condition under the existing lifecycle authority; no second slash command is required.
- `MODULE_NOT_FOUND` below `node_modules` now stops a worker after its first tool failure instead of consuming the eight-call budget.

### Security

- Controller-owned `npm ci` uses the Host Node installation's exact `npm-cli.js`, isolated empty npm configs and cache, an environment allowlist, disabled lifecycle scripts/audit/funding, HTTPS origins with supported integrity digests only, live file/byte/depth quotas, and process-tree cancellation. Unexpected packages, shims, hidden payloads, links and hardlinks are rejected, and publication never replaces an existing target.

## [0.3.14] - 2026-08-29

### Fixed

- `leppy_exec` now removes redundant shell quotes from its structured executable field and, on Windows, resolves a repository-local `node_modules/.bin/<tool>` to its existing `.cmd` shim before sandbox confinement. Worker guidance states that command and args are separate argv fields, so POSIX quoting is never passed to `cmd.exe`.
- Localized Windows `cmd.exe` failures for a quoted `node_modules` executable stop after the first tool error instead of exhausting eight calls. An exact authenticated prior failure may activate this compatibility bridge once under the existing lifecycle authority and repository lock; the condition digest and one-shot state are covered by the run-state HMAC.

## [0.3.13] - 2026-08-29

### Fixed

- Fresh npm worktrees may receive an isolated copy of a trusted, already-installed source `node_modules` only with one unambiguous npm lock, equal source/worktree metadata, a structurally current hidden npm receipt, exactly the recorded package directories, and only declared executable shims. Hydration copies that allowlist without dereferencing into private run-state staging, rejects external links and hardlinks, enforces file/byte limits and cancellation, validates staging, and publishes by atomic rename. It performs no download or install script and never deletes a target; the bounded isolated tree follows the preserved worktree lifecycle.
- An `ENOTCACHED`/`only-if-cached` stall with newly copyable dependencies is one proven changed condition, so the same persisted lifecycle authority can recover once without another slash command. The command binds an exact error digest; the runner revalidates it under the repository lock and requires a newly published isolated tree before clearing the circuit or starting a worker. Full recovery-state HMACs replace legacy identity-only proofs through a one-time lock-protected migration.
- Deterministic offline dependency misses now stop the worker after the first failed tool call instead of consuming all eight failure-budget slots.

## [0.3.12] - 2026-08-29

### Fixed

- Successful `git add` and `git commit` operations may now continue to an exact complete `rev-parse HEAD` reconciliation even when their diagnostic output exceeded the capture window. Content-bearing Git reads still reject lossy output, avoiding both silent partial search results and false failure reports after a commit was already created.

## [0.3.11] - 2026-08-29

### Fixed

- Git-backed worker tools now reject lossy stdout or stderr captures instead of treating a retained 256 KiB tail as complete. Oversized searches fail with `GIT_OUTPUT_OVERFLOW` and instruct the worker to narrow the query; commit/status checks receive the same fail-closed protection.

## [0.3.10] - 2026-08-29

### Fixed

- `leppy_search` now reports missing requested files or directories as a non-fatal discovery result instead of consuming the worker tool-failure budget. Existing scopes are still searched when requests mix present and absent paths; traversal, Git metadata, the controlling checklist, and unauthorized paths remain denied.

## [0.3.9] - 2026-08-29

### Fixed

- Worker prompts now enter `deployment:persona` through one opaque prompt variable, so literal template-like task or project text such as `{{ duration: 200 }}` is preserved without being reinterpreted as a Harness prompt-variable reference.

## [0.3.8] - 2026-08-29

### Fixed

- Reserved the user-facing `/leppy-loop` name exclusively for the Host command that mints direct-human lifecycle authority. The packaged guidance is now the model-only, non-user-invocable `leppy-loop-operator` skill, preventing slash-menu ambiguity that could load instructions without issuing the required permit.

## [0.3.7] - 2026-08-28

### Added

- Workers must finish with a structured `LEPPY_OUTCOME` disposition. `completed` requires passed validation evidence; blocked, failed, missing, malformed, and contradictory reports stall with the controller row open.
- New read-wide/write-scoped `leppy_search` and exact-text `leppy_edit` tools remove dependence on unavailable shell utilities and patches. Repo-local PowerShell `-File` scripts are supported on Windows.
- A native model-invocable `leppy-loop` skill and read-only `preflight` operation document and enforce canonical checklist/base resolution before a worktree is created.

### Changed

- Checklist lint rejects extension fragments, brace/glob syntax, ambiguous inferred basenames, and tasks that require tests without a test-capable write scope.
- Ordinary workers may read the worktree except for controlling/Git metadata, while every write and commit remains confined to declared task paths. Generic worker Git access is now a small positive metadata-only allowlist; content search goes through controller-excluding `leppy_search`, and mutation stays exclusive to `leppy_commit`. Nonzero argv exits are real tool errors.
- Retry attempt state is atomically persisted before a replacement worker starts. Three identical tool failures or eight total tool failures stop one worker turn; blocked/unavailable/repeated failures open a durable automatic-recovery circuit instead of consuming lifecycle transitions repeatedly.

### Fixed

- Closure prose such as `BLOQUEADO` and tasks reporting failed validation can no longer be adopted merely because Git invariants look clean.
- `leppy_loop_control` is always discoverable. Status reports a durable `running` controller with no session-owned Host job as `orphaned` and never returns or invents a stale job ID.
- Same-session lifecycle authority uses HMAC receipts plus an authenticated required-marker and monotonic head. Admissions persist before job start, publication downgrades before slash acknowledgment, and Stop revocation before kill; missing/corrupt modern authority is quarantined instead of treated as legacy. Mutable `run.json` is never authority. Plain continuation uses the exact durable `runId`; subagents and generic job monitoring are forbidden.

### Security

- Start still requires a direct human `/leppy-loop` permit. Signed authority remains session/repository/run-bound, expires after 24 hours, retains publication and transition limits, allows only publication downgrade, and cannot authorize another run. Direct-human Stop revokes it; Stop is absent from the model tool schema.
- Publication-conflict workers retain exact-path read/write/delete only; read widening and PowerShell execution apply only to ordinary task/closure workers.

## [0.3.6] - 2026-08-28

### Changed

- Progress cards now display an attempt ordinal scoped to the exact checklist row. Sequential tasks and durably split replacement rows begin at `Attempt 1`, while recovery of the same unchanged row advances its own ordinal.
- The pre-existing global attempt remains cumulative and continues to identify worker leases, artifacts, receipts, events, command pairs and authenticated recovery; lifecycle and repair budgets are unchanged.

## [0.3.5] - 2026-08-27

### Changed

- One `/leppy-loop` invocation now creates a reusable, bounded lifecycle permit for one session/repository/run. The AI can advance recovery, bounded gate repair and PR delivery from natural-language context and background outcomes without asking the human for separate continue/repair/publish slash commands.
- Arbitrary natural-language suffixes are accepted while technical paths, refs, run IDs, recovery modes and publication targets stay in the private tool. Explicit local-only/`do not publish` language irreversibly removes push/PR authority for that lifecycle.

### Fixed

- Publication reconciles an exact same-owner OPEN or MERGED PR before any fetch, rebase, gate or push, allowing manual publication to settle durable Leppy state without another remote mutation.
- Deleted remote bases are detected with `fetch --prune` plus `ls-remote` instead of stale tracking refs. A private replacement base cannot change the authenticated remote and requires a durable prior target commit and ancestry proof, including exact-base existing OPEN/MERGED PR reconciliation; MERGED delivery also proves its merge commit remains in the live base.
- Already-pushed rebased branches use an exact observed-OID `force-with-lease`. The publisher freezes the target OID, revalidates gate-validated HEAD, clean tree, live base and remote lease before push, verifies the resulting remote head, and re-lists PRs to absorb create races.
- `refs/heads/main`, slash-containing `refs/heads/release/1.0`, and `refs/remotes/origin/main` publication inputs resolve correctly; fetch/push GitHub repository mismatches and ambiguous push URLs fail closed.
- The clean-profile install smoke retains its HTTP/client-bundle assertions but allows 90 seconds for a cold Web boot after Windows-heavy test suites.

### Security

- Lifecycle permits are Host-memory-only, expire after 24 hours, bind to the first run once, reject concurrent transitions, enforce a cumulative sixteen-transition budget, and disappear on Host restart. Direct stop is absent from the model tool schema; repair scope, merge and deployment remain unauthorized.
- Repository admission is fenced across Agents before lease termination. Crash-stale locks carry PID/process-start/token ownership and are reclaimed through an exclusive recovery marker; live owners and stale disposer deletion fail closed.

## [0.3.4] - 2026-08-27

### Fixed

- Pull-request lookup and creation now derive an explicit `owner/repository` from the authenticated GitHub remote and pass it through `gh --repo`, preventing ambient repository inference from producing blank base/head SHAs after a successful branch push.

### Security

- Publication rejects non-GitHub, local, or ambiguous remote URLs before push instead of allowing `gh` to select an unrelated repository from ambient Git configuration.

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
