# Contributing

Open an issue before changing the public checklist/event contract. Keep compatibility changes explicit and tied to a tested DeepSeek Harness version.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm secret:scan
```

Use small conventional commits. Add regression coverage for behavior that was already supposed to work. Do not add broad decorative tests. Never include credentials, private transcripts, or generated run state.

Pull requests must explain the security boundary changed, platforms tested, and whether the upstream Harness pin changed. A green package test is not proof of a live provider call; keyless replay and real credential-bearing tests must be labeled separately.
