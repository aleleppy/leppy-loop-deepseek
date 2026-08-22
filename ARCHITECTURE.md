# Architecture

## Pinned integration

`0.1.0` targets DeepSeek Harness `0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. It is an external Cordis bundle (`dsh.bundle.patch`) and does not patch `agent-loop` or any upstream package.

The startup plugin consumes `ctx.cmdlineArgs`, `ctx.agentDefaultModel`, `ctx.llm`, and `ctx.credentials`. It validates catalog membership through `ctx.llm.listModels(provider)` and exact reasoning capabilities through `ctx.llm.resolveModelInfo(provider, model)`. Each worker uses `@deepseek-ai/dsh-sdk-client` to launch the official stdio JSON-RPC runtime.

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
- `parseChecklist(sourceOrPath, path?)`
- `lintChecklist(parsed, options?)`
- `HarnessWorkerAdapter`
- `LeppyLoopOptions`, `RunResult`, `RunEvent`

The dependency seam permits deterministic fake-worker tests without weakening the production adapter.
