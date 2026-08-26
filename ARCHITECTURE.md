# Architecture

## Pinned integration

`0.2.17` targets DeepSeek Harness `0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. It is an external Cordis bundle (`dsh.bundle.patch`) and does not patch `agent-loop`, the Web client, or any upstream package.

The command plugin consumes `ctx.commands`, `ctx.tools`, `ctx.agentDefaultModel`, `ctx.llm`, and `ctx.credentials`. It globally registers `/leppy-loop` and `leppy_loop_start`. An option-led slash invocation runs directly without entering model history. A bare or natural-language invocation queues one plugin-authored model turn: the agent receives any trailing human intent, inspects conversation and repository context, resolves the checklist/base or asks about genuine ambiguity, and calls the private controller tool. Relative paths resolve from the receiving agent session's absolute `cwd`. Cancellation reaches fetch, worker, and gate process trees; worktree creation and controller commits finish their short persistence-critical sections before cancellation is observed, so every mutation remains recoverable.

The runner's optional `onProgress` sink emits a typed start and terminal update for each selected row, measuring elapsed milliseconds from that task attempt's start. Web composition maps each pair to one synthetic `command/run`/`command/done` lifecycle under a deterministic per-attempt ID. The package root also declares a browser bundle that registers the keyed `leppy-loop-task` command row; it combines the durable zero baseline with the command event time and ticks locally once per second until the terminal update arrives. An explicit recovery starts a new attempt card and timer, while an internal no-commit retry retains the same card. Command lifecycle events are durable but model-invisible, preserving provider tool-call/result adjacency and avoiding per-tick Session writes or progress-token overhead.

The default bundle is command-only. The separately exported startup module remains available to explicit custom CLI compositions and claims process argv only when `--tasks` is present. Both entry points validate catalog membership through `ctx.llm.listModels(provider)` and exact reasoning capabilities through `ctx.llm.resolveModelInfo(provider, model)`. Each worker uses `@deepseek-ai/dsh-sdk-client` to launch the official stdio JSON-RPC runtime. The private runtime mounts both the native DeepSeek adapter and the Harness `llm-pi-ai` multi-provider adapter; it receives the selected provider profile and reuses the Harness credential store, so the current default model route is preserved instead of forcing `DEEPSEEK_API_KEY`. Cordis and `dsh-tools` remain Host-shared peers so registrations and the parallel-call scheduler use the same service symbols inside an installed profile.

For `openai-codex`, the default adaptive policy chooses Terra/high for a fresh ordinary task and Sol/low for closures, recovered work, availability retry, and one automatic retry after a completed clean-tree attempt creates zero commits. The controller retries only when the first attempt left no WIP. A second zero-commit result normally fails; the sole exception is an independent retry ending in one exact `LEPPY_ALREADY_SATISFIED:` evidence line on a clean unchanged branch, which produces a controller-owned checklist-only closure commit. Per-line metadata and explicit command options override policy fields independently. Other providers retain the Harness selection. Worker transcripts default to 8 MiB so OpenAI streaming chunks do not prematurely terminate recoverable work. Recovery receipts carry the authenticated run ID; when no selector is supplied, a sole stalled/interrupted run takes precedence over older failed artifacts. A completed run remains excluded from implicit recovery but can be continued explicitly by ID when a selective invocation left open rows in its preserved checklist.

After selection returns no open row, Web entry points complete locally by default. Only a direct, human-authored `--open-pr` slash command enables controller-side PR publication; the model-facing `leppy_loop_start` tool cannot request it. The publisher requires a clean worktree, fetches and rebases onto the remote base, verifies at least one commit remains, pushes the exact authenticated Leppy branch, and uses `gh pr list/create` idempotently. Publication failure stalls only an explicitly requested publication with a deterministic recovery command; success persists the URL before the final completed event. The worker runtime never receives these capabilities.

## Control flow

```text
source checkout (clean, tracked checklist)
        |
        v
single fetch -> authoritative ref -> run branch + sibling worktree
        |
        v
select first open literal match
   | task/closure                    | gate
   v                                 v
worker-host + fresh SDK session      controller platform shell, once
   |                                 |
scoped file/argv/commit tools        receipt + checklist commit
   |
validate branch/commit/tree/checklist
   |
controller marks checkbox and amends/commits
```

The worker-host is the process-tree ownership boundary. It writes a signed lease and launches the JSON-RPC runtime through `@deepseek-ai/dsh-subprocess-local`, whose handle terminates the complete child tree. SDK stdin/stdout are proxied without interpreting JSON-RPC.

## State and recovery

Run state is atomically replaced and stored under `<git-common-dir>/leppy-loop/runs/<run-id>` unless overridden. Ownership is HMAC-bound to run, repository, checklist, branch, and worktree. Worker leases additionally bind PID, process-start identity, task, attempt, and heartbeat. Recovery requires a unique valid ownership proof and matching Git facts.

State must remain outside the worktree. Otherwise leases, sessions, and transcripts would pollute the worker tree and correctly fail the scoped commit validator.

## Git transaction

Ordinary worker effects are one conventional commit. The controller checks exactly one new commit, expected branch, conventional subject, clean tree, and unchanged checklist. It then writes `[x]` and amends the commit. Closure allows zero or one commit; zero produces a controller closure commit. Gate produces its own receipt/checklist commit.

The official sandbox has one writable root. A Git linked worktree stores commit metadata in a separate `git-common-dir`, so a normal sandboxed `git commit` cannot work without widening the writable root beyond the worktree. `leppy_commit` is the deliberate narrow bridge: inspect changed names, reject anything outside allowed real paths, stage only allowed scopes, enforce a conventional message, and run exact Git argv with a scrubbed environment.

## Public API

- `runLeppyLoop(options, dependencies)`
- `executeLeppyLoopCommand(ctx, invocation, lifetimeSignal?, hooks?)`
- `parseLeppyLoopCommandInput(input)`
- `parseChecklist(sourceOrPath, path?)`
- `lintChecklist(parsed, options?)`
- `HarnessWorkerAdapter`
- `LeppyLoopOptions`, `RunResult`, `RunPreview`, `RunEvent`

The dependency seam permits deterministic fake-worker tests without weakening the production adapter.
