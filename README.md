# Leppy Loop for DeepSeek Harness

[Português (Brasil)](README.pt-BR.md)

Leppy Loop is a native external Cordis bundle that executes a tracked Markdown checklist with a fresh DeepSeek Harness process and session for each worker line. The controller owns Git synchronization, the worktree, checklist transitions, closure, gates, durable recovery state, and process leases. Workers receive only the current line, its `Done:` contract, allowed paths, applicable repository instructions, and explicit prohibitions.

Version `0.2.19` is pinned to DeepSeek Harness `0.1.1-rc.2`, upstream commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e). It registers a Host-side `/leppy-loop` command and a model-facing controller tool that the existing Web composer and agent discover without a client patch.

## Install

Node `22.19+`, Git, and pnpm `10.28.1` are required. DeepSeek Harness forwards plugin management to the `pnpm` found on `PATH`; pnpm 11 requires a separate native-build approval step and is not claimed as an install-compatible combination for `0.2.19`. Configure the credential for the model provider selected in the Harness Models page, then build and install the tarball into the profile used by the Web host. Workers reuse that provider, model profile, and credential automatically; `DEEPSEEK_API_KEY` is not required when another provider is selected:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add ./leppy-loop-deepseek-0.2.19.tgz
```

Restart the existing `dsh web` process after changing its profile. A browser refresh cannot compose a newly installed Host plugin. A published GitHub Release tarball may replace the local `.tgz` path; there is no claim of publication in a plugin registry.

## Quickstart

Create a tracked checklist such as [`examples/feature.task.md`](examples/feature.task.md), commit it, start a Web session whose workspace is that clean checkout, and invoke the command without arguments:

```text
/leppy-loop
```

The command queues an AI turn that inspects the conversation and repository, resolves the intended tracked checklist and authoritative Git base, and calls the private `leppy_loop_start` tool. If the target is genuinely ambiguous, the AI asks one concise question instead of guessing. Natural language after the command is forwarded as intent instead of parsed as CLI arguments, for example `/leppy-loop continue the checklist from this conversation`.

The deterministic explicit form remains available only when the input starts with an option such as `--tasks`:

```text
/leppy-loop --tasks ./tasks/feature.task.md --sync-branch origin/main --phase-gate-command "pnpm test"
```

Relative checklist and artifact paths resolve from the receiving session's workspace. Explicit arguments use a non-evaluating quoted argv grammar; the gate remains one explicitly quoted opaque argument.

The default `adaptive` worker policy uses `gpt-5.6-terra` at `high` for ordinary OpenAI Codex tasks, then `gpt-5.6-sol` at `low` for closures and recovery of a stalled task. A clean ordinary-task completion with zero commits is retried once automatically under the recovery policy. If that independent retry proves the `Done:` contract is already satisfied through the exact terminal evidence marker and leaves a clean unchanged branch, the controller closes only the checklist; dirty WIP, missing evidence, and an unverified repeated zero-commit result still fail closed. Inline `model=`/`effort=` metadata and explicit `--model`/`--effort` options take priority. Use `--worker-policy selected`, `terra-high`, or `sol-low` to choose another global behavior. The default transcript cap is 8192 KiB and remains configurable with `--worker-transcript-limit-kb`. Resume receipts include `--recover-run <id>` so recovery remains deterministic even when older failed runs still exist. A failed gate additionally requires a new direct human slash/CLI invocation with `--retry-gate`; the exact authenticated run ID is mandatory, every attempt remains receipted, and the model-facing tool cannot grant retry authority. Supplying an exact run ID may also continue a completed selective run on the next open checklist row in its preserved branch/worktree; completed runs are never chosen implicitly.

While a Web run is active, every selected row creates a durable progress card in chat at start. Its plugin-owned browser renderer updates that task attempt's elapsed wall-clock time locally once per second, then the same card settles with the completed/total count and final task duration on success, stall, or failure (for example, `Task completed — 14/57 — 3m 12s elapsed.`). A recovered interrupted row starts a new attempt card and timer; an internal no-commit verification remains inside the original card and duration. Only the start and terminal command-lifecycle records are durable and both remain excluded from model context, so the live timer writes no per-second events, consumes no tokens, and does not split tool-call/result pairing.

Web runs complete locally by default after every checklist row and gate succeeds. Only a direct, human-authored `--open-pr` slash command can make the controller fetch and rebase onto the remote base, push its exact Leppy branch, create or find the GitHub pull request with `gh`, store the URL, and return it to the chat. The autonomous model tool cannot enable publication, and workers cannot push or use `gh`. Install and authenticate GitHub CLI first (`gh auth status`) before opting in.

Preview exactly one selected line without starting a worker or reading a credential:

```text
/leppy-loop --tasks ./tasks/feature.task.md --sync-branch origin/main --dry-run
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

Ordinary tasks require a non-empty `Done:` and explicit repo-relative paths, either through `paths=a,b` or path-shaped backtick spans. The canonical pipe format is preferred, but indented Markdown continuations and the historical `[closure]`/`[gate]`, `Paths:`, `Paths EXATOS:`, `Paths permitidos:` and multiline `Done:` forms are accepted. A `[?] [human]` or `[?] [human/live]` checkpoint is never sent to a worker: the run stalls with its preserved worktree until a human marks that row complete and recovers the exact run. The commit capability stages the exact validated changed files; an ignored untracked file is eligible only when it sits beneath one of those explicit scopes, allowing intentionally versioned migrations without sweeping unrelated ignored material. `--task-match` is a literal substring, not a regular expression. A phase may omit closure, gate, or both; when both exist they must be adjacent and final among automated rows. Markdown outside checkbox markers is preserved byte-for-byte except for the file's existing newline convention.

A tracked root `.leppy-loop.json` may contain a string `customInstructions`; it is appended to the applicable `AGENTS.md`/`CLAUDE.md` instructions for every worker. Invalid shapes fail closed, the file is capped at 64 KiB, and the instruction string at 32 KiB. Dry-run results include all lint diagnostics through both the model-facing tool and direct command text.

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

This is practical isolation, not a network sandbox. File tools enforce allowed real paths; ordinary argv commands use the official `workspace-write` sandbox and have no shell string interface. Remote clients, publication, deploy, PR mutation, branch integration, worktree management, dynamic evaluation, and the phase gate fingerprint are denied.

Git worktree commits necessarily update `git-common-dir`, which is outside the worktree sandbox root. Therefore commits use a separate narrow `leppy_commit` capability: it accepts only a conventional message, verifies every changed path is in task scope, stages only those scopes, and invokes exact Git argv. It does not expose general access to Git metadata.

The official sandbox does not confine network access. A malicious repository script already allowed as a focal test can still use network or perform behavior permitted by the OS account. Do not run Leppy Loop on untrusted repositories. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Costs and limitations

Each line starts an independent context, so shared conversational cache is intentionally lost and model cost may be higher. Version `0.2.0` supports only the tested Harness pin. Network confinement, automatic push, PR mutation, release publication, package publication, and deployment are not provided. No remote action is automatic.

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
