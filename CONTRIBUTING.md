# Contributing

Open an issue before changing the public checklist/event contract. Keep compatibility changes explicit and tied to a tested DeepSeek Harness version.

```sh
pnpm install
pnpm gate
```

The canonical gate includes lint, typecheck, unit/integration tests, the real WSL2 capsule boundary on supported Windows release Hosts, build, pack inspection, clean-profile install/boot smoke, and secret scanning. Non-Windows runs record the explicit WSL platform skip.

Use small conventional commits. Add regression coverage for behavior that was already supposed to work. Do not add broad decorative tests. Never include credentials, private transcripts, or generated run state.

Pull requests must explain the security boundary changed, platforms tested, and whether the upstream Harness pin changed. A green package test is not proof of a live provider call; keyless replay and real credential-bearing tests must be labeled separately.
