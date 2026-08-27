# Threat model

## Protected assets

- DeepSeek credentials and credential-bearing headers/URLs.
- Source checkout and unrelated worktrees.
- Controlling checklist integrity.
- Git remote state, releases, packages, PRs, and deployments.
- Correct ownership of running/stale worker processes.

## Enforced controls

- Realpath-based path allowlist; traversal and escaping symlinks/junctions fail closed.
- Checklist denied by file tools and verified by digest after every worker.
- Exact argv tool; worker shell interpreters, dynamic eval, remote clients, `git push`, `gh`, publication/deploy, integration, and worktree commands denied.
- Ordinary commands wrapped by the official `workspace-write` sandbox with no escalation path.
- Narrow commit capability validates every changed path and stages only the exact changed-path set. Ignored untracked files are discovered only beneath explicitly declared task scopes before a narrow force-add, so a scoped versioned migration is permitted without sweeping unrelated ignored material. A completed clean-tree ordinary attempt with zero commits may retry once. Terminal Agent errors observed in SDK notifications are classified before this branch, so provider overload cannot masquerade as a completed no-commit task. The controller never manufactures an empty commit: it accepts a repeated zero-commit result only with one exact final already-satisfied evidence marker from the independent retry on a clean unchanged branch, then records a checklist-only closure commit; dirty WIP or missing evidence still fails.
- The selected provider credential is resolved by Harness or its isolated credential store and remains inside the model runtime; model-facing tools never expose it, and their subprocess environments are scrubbed.
- Recursive redaction of sensitive names, known values, headers, and URL userinfo.
- Atomic state, per-common-dir lock, HMAC ownership proofs and leases, PID plus process-start identity checks, and tree-scoped termination. Exact recovery may ignore the receiving source checkout's branch/dirty state only after ownership authentication and preserved worktree/branch verification; fresh runs still require a clean tracked source controller.
- Gate command fingerprint is denied in workers. Gates never retry without fresh direct-human authority after failure/crash. A repeated fingerprint requires a one-shot capability minted by simple human retry/repair intent and bound to the exact session, repository, authenticated run and operation; a repair capability consumes at most three cycles, model arguments cannot create authority, and every attempt receives a durable receipt. Repair fails closed on a dirty worktree, reopens only the immediately preceding completed closure through a controller commit, and gives a bounded prior receipt to a fresh worker. Direct-human `--repair-path` additions are allowed only with exact-run repair authority, must canonicalize to existing paths inside the authenticated worktree, cannot target the controller, are durably recorded, and remain absent from the model tool; commit validation uses the union of original and explicitly added scopes.
- The Web slash interface accepts only simple intent and rejects technical flags. Start/continue returns after enqueueing a short resolver turn; agent-scoped `leppy_loop_control` consumes an expiring one-shot grant before transferring work into the owner-fenced Harness job registry. Grants cannot cross or replay across Agent/session, repository, run, operation or publication intent. Continuation also binds a Host-captured digest of checklist bytes, source head, branch, worktree, base, task/attempt counters and gate-attempt map; any mutation between slash authorization and tool consumption is denied.
- A clean checkout may supply tracked `.leppy-loop.json` `customInstructions`. Parsing, shape and byte caps fail closed before a worker starts; the text is treated as repository-authored instruction under the same trusted-repository boundary as `AGENTS.md`, `CLAUDE.md`, scripts and hooks.
- Remote publication is disabled by default and absent from the scoped tool schema. Only explicit human publication language records it inside the matching one-shot capability, and only after no open checklist row remains can the controller use it. A post-completion publish intent selects only an authenticated controller with no open row in `completed` or publication-stalled state and binds its current authority digest before the scoped tool can re-enter publication. A new publish grant authenticates `head-name`, `onto`, `orig-head`, and backend before aborting any interrupted prior rebase, so partial/manual resolution never crosses jobs. In one live job, rebase conflicts expose only exact Git unmerged file paths to fresh recovery workers, bounded by the controller-side grant limit. Conflict workers receive no commit or exec capability and cannot touch the checklist, index, HEAD, Git sequencer, gate, push, or `gh`. The controller freezes authenticated rebase identity, HEAD and the complete staged index; it rejects index drift, a changed unmerged set, untracked paths, or edits outside the exact conflicts. Only the controller stages those resolved paths and continues the rebase, preserving clean paths already staged by Git. It then reruns the final gate before it can push the exact controller-owned branch, derive an explicit `owner/repository` from the authenticated GitHub remote, find/create one PR idempotently through `gh --repo`, and persist the URL.
- Task progress uses paired, deterministic command-lifecycle records carrying only bounded checklist text, attempt, counts, and an elapsed-time baseline. The long label alone elides while status/attempt/timer remain separate. General controller status/cancel uses owner-fenced job snapshots plus a direct human stop command. Browser ticks create no durable per-second writes; progress remains outside model history and excludes worker output, credentials, gate output, and mutable repository data.

## Explicit non-goals

The Harness filesystem sandbox does not confine network. Existing repository scripts may access network, invoke native code, exploit the OS account, or hide behavior behind an otherwise permitted test command. The v0.3.4 boundary assumes the repository and its existing scripts are trusted.

The narrow Git commit bridge writes shared Git metadata. Validation prevents it from staging out-of-scope worktree paths, but a hostile repository with crafted Git configuration/hooks could affect commit execution. Leppy sets no blanket claim against malicious Git hooks; use clean trusted repositories and review local Git configuration.

This project does not merge PRs, mutate issues/releases/packages, deploy, or clean preserved WIP. Its only remote mutation is the explicitly opted-in controller-owned branch push and PR creation described above.

## Reporting

Follow [SECURITY.md](SECURITY.md). Do not include real credentials or private repository data in a report.
