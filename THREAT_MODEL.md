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
- Narrow commit capability validates every changed path and stages only the exact changed-path set. Ignored untracked files are discovered only beneath explicitly declared task scopes before a narrow force-add, so a scoped versioned migration is permitted without sweeping unrelated ignored material. A completed clean-tree ordinary attempt with zero commits may retry once. The controller never manufactures an empty commit: it accepts a repeated zero-commit result only with one exact final already-satisfied evidence marker from the independent retry on a clean unchanged branch, then records a checklist-only closure commit; dirty WIP or missing evidence still fails.
- The selected provider credential is resolved by Harness or its isolated credential store and remains inside the model runtime; model-facing tools never expose it, and their subprocess environments are scrubbed.
- Recursive redaction of sensitive names, known values, headers, and URL userinfo.
- Atomic state, per-common-dir lock, HMAC ownership proofs and leases, PID plus process-start identity checks, and tree-scoped termination.
- Gate command fingerprint is denied in workers. Gates run once per explicit invocation and never auto-retry after failure/crash.
- Option-led Web arguments remain a direct human command with a non-evaluating quoted argv grammar. Bare or natural-language `/leppy-loop` delegates checklist/base selection and the trailing human intent to the session model; the private `leppy_loop_start` tool preserves the same controller validation, workspace resolution, cancellation controls, and visible lint diagnostics.
- A clean checkout may supply tracked `.leppy-loop.json` `customInstructions`. Parsing, shape and byte caps fail closed before a worker starts; the text is treated as repository-authored instruction under the same trusted-repository boundary as `AGENTS.md`, `CLAUDE.md`, scripts and hooks.
- Remote publication is disabled by default and absent from the model-facing tool schema. Only a direct, human-authored `--open-pr` command enables it after no open checklist row remains. It requires a clean authenticated worktree, rebases onto the configured remote base, pushes the exact controller-owned branch, finds/creates one PR idempotently through authenticated `gh`, and persists the returned URL.
- Task progress uses paired, deterministic command-lifecycle records carrying only bounded checklist text, counts, and an elapsed-time baseline. The browser ticks from that baseline locally without durable per-second writes. Progress remains outside model history and never includes worker output, credentials, gate output, or mutable repository data.

## Explicit non-goals

The Harness filesystem sandbox does not confine network. Existing repository scripts may access network, invoke native code, exploit the OS account, or hide behavior behind an otherwise permitted test command. The v0.2.18 boundary assumes the repository and its existing scripts are trusted.

The narrow Git commit bridge writes shared Git metadata. Validation prevents it from staging out-of-scope worktree paths, but a hostile repository with crafted Git configuration/hooks could affect commit execution. Leppy sets no blanket claim against malicious Git hooks; use clean trusted repositories and review local Git configuration.

This project does not merge PRs, mutate issues/releases/packages, deploy, or clean preserved WIP. Its only remote mutation is the explicitly opted-in controller-owned branch push and PR creation described above.

## Reporting

Follow [SECURITY.md](SECURITY.md). Do not include real credentials or private repository data in a report.
