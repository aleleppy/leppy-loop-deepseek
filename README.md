# Leppy Loop for DeepSeek Harness

[Português (Brasil)](README.pt-BR.md)

Leppy Loop is a native external Cordis bundle that executes a tracked Markdown checklist with a fresh DeepSeek Harness process and session for each worker line. The controller owns Git synchronization, the worktree, checklist transitions, closure, gates, durable recovery state, and process leases. Workers receive only the current line, its `Done:` contract, allowed paths, applicable repository instructions, and explicit prohibitions.

Version `0.1.0` is pinned to DeepSeek Harness `0.1.1-rc.2`, upstream commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e).

## Install

Node `22.19+`, Git, and pnpm `10.28.1` are required. DeepSeek Harness forwards plugin management to the `pnpm` found on `PATH`; pnpm 11 requires a separate native-build approval step and is not claimed as an install-compatible combination for `0.1.0`. Configure `DEEPSEEK_API_KEY` through the Harness credential service, then install the release tarball in a dedicated profile:

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile leppy-loop add https://github.com/aleleppy/leppy-loop-deepseek/releases/download/v0.1.0/leppy-loop-deepseek-0.1.0.tgz
```

Bundles are intentionally distributed through a GitHub Release tarball and Git URL. There is no claim of publication in a plugin registry.

## Quickstart

Create a tracked checklist such as [`examples/feature.task.md`](examples/feature.task.md), commit it, and start from a clean checkout:

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 --profile leppy-loop \
  --tasks ./tasks/feature.task.md \
  --sync-branch origin/main \
  --phase-gate-command "pnpm test"
```

Preview exactly one selected line without starting a process or reading a credential:

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 --profile leppy-loop \
  --tasks ./tasks/feature.task.md --sync-branch origin/main --dry-run
```

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

Ordinary tasks require a non-empty `Done:` and explicit repo-relative paths, either through `paths=a,b` or path-shaped backtick spans. `--task-match` is a literal substring, not a regular expression. A phase may omit closure, gate, or both; when both exist they must be adjacent and final. Markdown outside checkbox markers is preserved byte-for-byte except for the file's existing newline convention.

Paths are resolved through filesystem identity. Traversal, absolute paths, and symlinks/junctions escaping the worktree are rejected. The controlling checklist is always denied to workers.

## Options

| Option | Default |
|---|---:|
| `--sync-max-seconds` | 120 |
| `--worker-timeout` | 30 minutes |
| `--max-iterations` | 64 |
| `--worker-output-limit-kb` | 192 KiB |
| `--worker-transcript-limit-kb` | 2048 KiB |
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
3. Each ordinary line gets a new worker process and SDK session. It must leave exactly one conventional commit and a clean tree. The controller then changes its checkbox to `[x]` and amends that commit.
4. Closure gets a new worker and may leave one corrective conventional commit or no commit. The controller records completion.
5. Gate has no worker. The controller executes the opaque command once through the platform shell, writes a receipt, marks the line, and commits both. Failure or interruption is never retried automatically.

Leppy differs from a generic Ralph loop by making a repository checklist the controller-owned state machine. Ralph commonly repeats an objective until a worker reports completion; Leppy selects one typed line, gives it bounded path scope, validates its Git effect, and makes closure/gate explicit phase transitions.

## Events

`events.jsonl` uses the versioned envelope:

```json
{"schemaVersion":1,"type":"start","runId":"...","timestamp":"...","phase":"worker","taskIndex":0,"attempt":1,"data":{}}
```

The event type union is exactly:

`run-start`, `start`, `done`, `recovery-start`, `recovery-done`, `gate-start`, `gate-end`, `stall`, `timeout`, `gate-failed`, `run-end`.

The package exports `runLeppyLoop`, `parseChecklist`, `lintChecklist`, `HarnessWorkerAdapter`, `LeppyLoopOptions`, `RunResult`, and `RunEvent`.

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

This is practical isolation, not a network sandbox. File tools enforce allowed real paths; ordinary argv commands use the official `workspace-write` sandbox and have no shell string interface. Remote clients, publication, deploy, PR mutation, branch integration, worktree management, dynamic evaluation, and the phase gate fingerprint are denied.

Git worktree commits necessarily update `git-common-dir`, which is outside the worktree sandbox root. Therefore commits use a separate narrow `leppy_commit` capability: it accepts only a conventional message, verifies every changed path is in task scope, stages only those scopes, and invokes exact Git argv. It does not expose general access to Git metadata.

The official sandbox does not confine network access. A malicious repository script already allowed as a focal test can still use network or perform behavior permitted by the OS account. Do not run Leppy Loop on untrusted repositories. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Costs and limitations

Each line starts an independent context, so shared conversational cache is intentionally lost and model cost may be higher. Version `0.1.0` supports only the tested Harness pin. Network confinement, automatic push, PR mutation, release publication, package publication, and deployment are not provided. No remote action is automatic.

## Uninstall

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile leppy-loop remove leppy-loop-deepseek
```

Remove the profile separately if you no longer need it. Worktrees and preserved WIP are never deleted automatically.

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
