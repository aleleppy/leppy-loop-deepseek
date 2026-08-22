# Leppy Loop para DeepSeek Harness

[English](README.md)

Leppy Loop é um bundle Cordis externo e nativo que executa uma checklist Markdown rastreada com um processo e uma sessão novos do DeepSeek Harness por linha de worker. O controller é dono do Git, worktree, transições da checklist, closure, gates, recuperação durável e leases de processo.

A versão `0.1.0` é fixada no DeepSeek Harness `0.1.1-rc.2`, commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e).

## Instalação

Requer Node `22.19+` e Git. Configure `DEEPSEEK_API_KEY` no serviço de credenciais do Harness:

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile leppy-loop add https://github.com/aleleppy/leppy-loop-deepseek/releases/download/v0.1.0/leppy-loop-deepseek-0.1.0.tgz
```

## Uso rápido

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 --profile leppy-loop \
  --tasks ./tasks/feature.task.md \
  --sync-branch origin/main \
  --phase-gate-command "pnpm test"
```

Prévia sem processo ou consumo de credencial:

```sh
npx @deepseek-ai/dsh@0.1.1-rc.2 --profile leppy-loop \
  --tasks ./tasks/feature.task.md --sync-branch origin/main --dry-run
```

## Contrato da checklist

```md
## Fase API

- [ ] Criar `src/api.ts` | Done: GET /health responde 200 | model=deepseek-v4-pro | effort=high
- [ ] Documentar endpoint | Done: README descreve /health | paths=README.md
- [?] Closure: revisar a fase | paths=src,README.md
- [~] Gate: testes focais
```

- `[ ]`: tarefa comum aberta.
- `[?]`: closure aberta.
- `[~]`: gate do controller aberto.
- `[x]`: linha concluída de qualquer tipo.

Tarefa comum exige `Done:` não vazio e paths repo-relative explícitos em `paths=` ou entre crases. `--task-match` é substring literal. Paths passam por `realpath`; traversal, absoluto e symlink/junction escapando do repositório são recusados. O worker nunca pode ler ou editar a checklist controladora.

## Semântica

O checkout e a checklist rastreada precisam estar limpos. O controller faz no máximo um fetch, resolve `--sync-branch`, cria uma branch `leppy-loop/<tasks>-<run-id>` e uma worktree irmã. Não sincroniza de novo durante o loop.

Cada tarefa recebe um processo/sessão efêmero e deve deixar exatamente um commit conventional e árvore limpa. Closure pode deixar um commit corretivo ou nenhum. Gate não cria worker: o controller roda o comando opaco uma vez, grava recibo e marca a linha. Falha/crash de gate nunca repete sozinho.

Defaults: sync 120 s, worker 30 min, 64 inicializações, output final 192 KiB e transcript 2 MiB. Provider/model/effort vêm da seleção atual do Harness, são validados no catálogo real, e o fallback ocorre uma vez apenas por indisponibilidade/rate limit.

## Recuperação

Estado durável fica fora da worktree: `run.json`, PID do runner, eventos JSONL, outputs, transcripts, recibos, resumos de diff, instrução de retomada, prova de ownership e leases HMAC. Há um lock por `git-common-dir`.

Timeout, limite ou Ctrl+C preserva WIP e a mesma linha. Retome com `--recover-existing-wip`. O controller só adota um único run autenticado correspondente. Só encerra uma árvore quando lease, PID e identidade de início ainda coincidem; nunca busca ou mata por nome.

## Segurança e limitações

É isolamento prático, não absoluto. File tools respeitam paths permitidos. Comandos usam argv exato, sem shell do worker, sob `workspace-write`. Clientes remotos, push, `gh`, publicação, deploy, mutação de PR, integração/worktree e avaliação dinâmica são negados. A chave vem do serviço de credenciais e subprocessos de ferramenta recebem ambiente scrubbed; logs/eventos são redigidos.

Commit em Git worktree grava no `git-common-dir`, fora da raiz do sandbox. Por isso existe uma capability estreita `leppy_commit`: ela valida todos os arquivos alterados, stageia somente os escopos declarados e aceita apenas mensagem conventional. Ela não expõe Git geral.

O sandbox oficial não confina rede. Um script malicioso já presente no repositório pode usar rede durante um teste permitido. Não use em repositório não confiável. Push, PR, release, publicação e deploy nunca são automáticos.

Leppy difere de Ralph porque a checklist tipada é a máquina de estados controlada: uma linha por sessão, escopo de paths, validação Git, closure e gate explícitos. O contexto independente aumenta o custo porque conversa/cache não é compartilhada.

Para todos os flags, eventos, troubleshooting, API e desenvolvimento, veja o [README em inglês](README.md), [ARCHITECTURE.md](ARCHITECTURE.md) e [THREAT_MODEL.md](THREAT_MODEL.md).

## Licença

Apache-2.0.
