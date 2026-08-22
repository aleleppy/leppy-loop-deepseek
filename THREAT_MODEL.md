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
- Narrow commit capability validates every changed path and stages only declared scopes.
- Credential resolved through Harness and passed only to model-runtime environment; tool subprocess environments are scrubbed.
- Recursive redaction of sensitive names, known values, headers, and URL userinfo.
- Atomic state, per-common-dir lock, HMAC ownership proofs and leases, PID plus process-start identity checks, and tree-scoped termination.
- Gate command fingerprint is denied in workers. Gates run once per explicit invocation and never auto-retry after failure/crash.

## Explicit non-goals

The Harness filesystem sandbox does not confine network. Existing repository scripts may access network, invoke native code, exploit the OS account, or hide behavior behind an otherwise permitted test command. The v0.1 boundary assumes the repository and its existing scripts are trusted.

The narrow Git commit bridge writes shared Git metadata. Validation prevents it from staging out-of-scope worktree paths, but a hostile repository with crafted Git configuration/hooks could affect commit execution. Leppy sets no blanket claim against malicious Git hooks; use clean trusted repositories and review local Git configuration.

This project does not perform push, PR mutation, package publication, release publication, deployment, or cleanup of preserved WIP. Users perform those operations separately.

## Reporting

Follow [SECURITY.md](SECURITY.md). Do not include real credentials or private repository data in a report.
