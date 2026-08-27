# Leppy Loop para DeepSeek Harness

[English](README.md)

Leppy Loop é um bundle Cordis externo e nativo que executa uma checklist Markdown rastreada com um processo e uma sessão novos do DeepSeek Harness por linha de worker. O controller é dono do Git, worktree, transições da checklist, closure, gates, recuperação durável e leases de processo.

A versão `0.2.20` é fixada no DeepSeek Harness `0.1.1-rc.2`, commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e). Ela registra o comando Host `/leppy-loop` e uma ferramenta de controller para o modelo, descobertos pelo composer Web e pelo agente sem patch de client.

## Instalação

Requer Node `22.19+`, Git e pnpm `10.28.1`. O DeepSeek Harness repassa a gestão de plugins ao `pnpm` encontrado no `PATH`; pnpm 11 exige aprovação separada de builds nativos e não é uma combinação de instalação afirmada para `0.2.20`. Configure a credencial do provedor selecionado na página Models do Harness, gere o pacote e instale no profile usado pelo Web host. Os workers reutilizam automaticamente o provedor, o perfil do modelo e a credencial selecionados; `DEEPSEEK_API_KEY` não é necessária quando outro provedor está ativo:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add ./leppy-loop-deepseek-0.2.20.tgz
```

Reinicie o processo `dsh web` existente depois de alterar o profile. Refresh do navegador não compõe um plugin Host recém-instalado. Um tarball publicado no GitHub Release pode substituir o path do `.tgz` local; não há afirmação de publicação em registry de plugins.

## Uso rápido

Abra uma sessão Web cujo workspace seja o checkout limpo que contém a checklist rastreada e use apenas:

```text
/leppy-loop
```

O comando enfileira um turno da IA. Ela inspeciona a conversa e o repositório, resolve a checklist rastreada pretendida e a base Git autoritativa, e chama a ferramenta privada `leppy_loop_start`. Se houver ambiguidade real, a IA faz uma única pergunta curta em vez de adivinhar. Texto natural depois do comando vira intenção para a IA, não argv; por exemplo: `/leppy-loop continue a checklist desta conversa`.

A forma determinística explícita continua disponível apenas quando a entrada começa com uma opção como `--tasks`:

```text
/leppy-loop --tasks ./tasks/feature.task.md --sync-branch origin/main --phase-gate-command "pnpm test"
```

Paths relativos partem do workspace da sessão. Argumentos explícitos usam uma gramática argv com aspas, sem avaliação de shell; o gate continua sendo um único argumento opaco explicitamente citado.

A política padrão `adaptive` usa `gpt-5.6-terra` com esforço `high` nas tarefas comuns do OpenAI Codex e muda para `gpt-5.6-sol` com esforço `low` nas closures e na recuperação de uma tarefa parada. Notificações terminais do SDK por overload, indisponibilidade temporária, rate limit e HTTP 502/503 continuam sendo falhas de disponibilidade mesmo quando o SDK resolve com resposta final vazia: recebem uma vez o fallback de disponibilidade e depois param com recibo recuperável. Elas nunca entram na verificação de zero commits. Uma tarefa comum realmente concluída com árvore limpa e zero commits recebe automaticamente uma única nova tentativa pela política de recuperação. Se essa tentativa independente provar que o contrato `Done:` já está satisfeito pelo marcador terminal exato e deixar o branch limpo e inalterado, o controller fecha somente a checklist; WIP sujo, evidência ausente e zero commits repetido sem verificação continuam falhando de forma fechada. Metadados `model=`/`effort=` na linha e opções explícitas `--model`/`--effort` têm prioridade. Use `--worker-policy selected`, `terra-high` ou `sol-low` para escolher outro comportamento global. O limite padrão de transcript é 8192 KiB e pode ser alterado com `--worker-transcript-limit-kb`. Os recibos de retomada incluem `--recover-run <id>` para evitar ambiguidade quando ainda existem runs antigos com falha. Um gate que falhou exige também uma nova invocação slash/CLI humana direta com `--retry-gate`; o ID autenticado exato é obrigatório, toda tentativa permanece registrada e a ferramenta do modelo não pode conceder essa autoridade. Um ID exato também pode continuar um run seletivo já concluído na próxima linha aberta do branch/worktree preservado; runs concluídos nunca são escolhidos implicitamente.

Durante um run Web, cada row selecionada cria um card durável no chat quando começa. O renderer Web do plugin atualiza localmente a duração daquela tentativa de tarefa a cada segundo; depois o mesmo card é finalizado com a contagem concluída/total e a duração final da tarefa em sucesso, stall ou falha (por exemplo, `Task completed — 14/57 — 3m 12s elapsed.`). Uma row interrompida e recuperada começa um novo card e timer de tentativa; uma verificação interna de no-commit permanece no card e na duração originais. Somente os registros inicial e terminal são duráveis e ambos ficam fora do contexto do modelo, portanto o timer ao vivo não grava eventos por segundo, não consome tokens nem quebra o pareamento entre tool call e resultado.

Runs Web agora terminam apenas localmente por padrão depois que todas as linhas e gates passam. Somente um slash command direto e escrito pelo humano com `--open-pr` pode fazer o controller buscar e rebasear a base remota, enviar o branch Leppy, criar ou encontrar a pull request com `gh`, salvar a URL e devolvê-la ao chat. A ferramenta autônoma do modelo não pode habilitar publicação, e workers continuam sem permissão para push ou `gh`. Instale e autentique o GitHub CLI (`gh auth status`) antes de optar pela publicação.

Prévia sem worker ou consumo de credencial:

```text
/leppy-loop --tasks ./tasks/feature.task.md --sync-branch origin/main --dry-run
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

Tarefa comum exige `Done:` não vazio e paths repo-relative explícitos em `paths=` ou entre crases. O formato canônico com pipes é preferido, mas continua compatível com continuações Markdown indentadas e as formas históricas `[closure]`/`[gate]`, `Paths:`, `Paths EXATOS:`, `Paths permitidos:` e `Done:` multiline. Um checkpoint `[?] [human]` ou `[?] [human/live]` nunca inicia worker: o run para com o worktree preservado até um humano marcar a row e recuperar o ID exato. A capability de commit faz stage somente dos arquivos alterados exatos já validados; um arquivo ignorado e não rastreado só é elegível quando está sob um desses escopos explícitos, permitindo migrations intencionalmente versionadas sem varrer material ignorado não relacionado. `--task-match` é substring literal. Paths passam por `realpath`; traversal, absoluto e symlink/junction escapando do repositório são recusados. O worker nunca pode ler ou editar a checklist controladora.

Um `.leppy-loop.json` rastreado na raiz pode fornecer `customInstructions` string, anexada às instruções `AGENTS.md`/`CLAUDE.md` aplicáveis. Shapes inválidos falham fechados; o arquivo tem limite de 64 KiB e a string, 32 KiB. Dry-run expõe todos os diagnósticos de lint na ferramenta do modelo e no texto do comando direto.

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
