# Leppy Loop para DeepSeek Harness

[English](README.md)

Leppy Loop é um bundle Cordis externo e nativo que executa uma checklist Markdown rastreada com um processo e uma sessão novos do DeepSeek Harness por linha de worker. O controller é dono do Git, worktree, transições da checklist, closure, gates, recuperação durável e leases de processo.

A versão `0.3.1` é fixada no DeepSeek Harness `0.1.1-rc.2`, commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e). Ela registra um comando Host humano simples, uma tool de controller restrita ao agente e validada por grants, e cards Web sem patch do Harness.

## Instalação

Requer Node `22.19+`, Git e pnpm `10.28.1`. O DeepSeek Harness repassa a gestão de plugins ao `pnpm` encontrado no `PATH`; pnpm 11 exige aprovação separada de builds nativos e não é uma combinação de instalação afirmada para `0.3.1`. Configure a credencial do provedor selecionado na página Models do Harness, gere o pacote e instale no profile usado pelo Web host. Os workers reutilizam automaticamente o provedor, o perfil do modelo e a credencial selecionados; `DEEPSEEK_API_KEY` não é necessária quando outro provedor está ativo:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add ./leppy-loop-deepseek-0.3.1.tgz
```

Reinicie o processo `dsh web` existente depois de alterar o profile. Refresh do navegador não compõe um plugin Host recém-instalado. Um tarball publicado no GitHub Release pode substituir o path do `.tgz` local; não há afirmação de publicação em registry de plugins.

## Uso rápido

Abra uma sessão Web no repositório e escreva somente intenção humana — nunca paths, base, run ID, fingerprint, scope, ciclos ou flags de repair:

```text
/leppy-loop
/leppy-loop continuar
/leppy-loop parar
/leppy-loop status
/leppy-loop publicar
/leppy-loop continuar e publicar quando tudo passar
```

O slash command retorna assim que aceita a intenção. Start/continue enfileira um turno curto da IA; o Host valida e consome um grant one-shot e transfere o controller para `ctx.jobs`, liberando o RPC e o composer. A tool restrita ao agente `leppy_loop_control` recebe checklist/base/run técnicos, mas não cria autoridade: o grant é preso à sessão viva, repositório canônico, run autenticado, operação, expiração, limite de iterações, limite de repair e intenção explícita de publicação. Replay e uso em outra sessão/repo/run são negados.

`continuar` seleciona controller-side o run HMAC autenticado mais recentemente atualizado com trabalho aberto e verifica worktree/branch preservados. `tentar gate novamente` e `reparar gate` são intenções humanas separadas. A conclusão permanece local sem a palavra explícita `publicar`. A composição CLI exportada separadamente mantém os argumentos técnicos para automação; o slash Web rejeita essas flags.

A política padrão `adaptive` usa `gpt-5.6-terra` com esforço `high` nas tarefas comuns do OpenAI Codex e muda para `gpt-5.6-sol` com esforço `low` nas closures e na recuperação de uma tarefa parada. Notificações terminais do SDK por overload, indisponibilidade temporária, rate limit e HTTP 502/503 continuam sendo falhas de disponibilidade mesmo quando o SDK resolve com resposta final vazia: recebem uma vez o fallback de disponibilidade e depois param com recibo recuperável. Elas nunca entram na verificação de zero commits. Uma tarefa comum realmente concluída com árvore limpa e zero commits recebe automaticamente uma única nova tentativa pela política de recuperação. Se essa tentativa independente provar que o contrato `Done:` já está satisfeito pelo marcador terminal exato e deixar o branch limpo e inalterado, o controller fecha somente a checklist; WIP sujo, evidência ausente e zero commits repetido sem verificação continuam falhando de forma fechada. Metadados `model=`/`effort=` na linha e opções CLI `--model`/`--effort` têm prioridade. Use `--worker-policy selected`, `terra-high` ou `sol-low` para escolher outro comportamento global. O limite padrão de transcript é 8192 KiB e pode ser alterado com `--worker-transcript-limit-kb`. Os recibos de retomada incluem `--recover-run <id>` para evitar ambiguidade quando ainda existem runs antigos com falha. A retomada autenticada exata resolve e valida o controller na worktree preservada do run, portanto o checkout fonte pode ter mudado de branch, removido a checklist ou conter alterações sujas não relacionadas; runs novos continuam exigindo checkout fonte limpo e checklist tracked. Um gate que falhou exige nova intenção humana direta `tentar gate novamente` ou `reparar gate`; a tool restrita reconstrói o run exato e o controller aceita somente o mesmo fingerprint. O reparo recusa worktree suja, cria um commit de reabertura do controller e só é aceito pela tool restrita com grant humano correspondente. Quando o gate provar que a closure original omitiu artefatos gerados ou dependências necessárias, uma pessoa pode adicionar scopes existentes na worktree com `--repair-path <path...>`; as adições são validadas, persistidas, registradas e concedidas somente ao worker de reparo reaberto. Comandos na raiz podem omitir `cwd` ou usar `cwd="."`, enquanto a validação do commit continua limitada ao scope efetivo. Uma invocação direta de reparo encadeia por padrão até três ciclos de closure nova/gate, entregando cada novo recibo vermelho ao worker seguinte; `--repair-cycles <1..8>` altera esse limite rígido. O processo para imediatamente em sucesso, falha do worker, estado sujo, fingerprint alterado, cancelamento ou esgotamento, sem loop infinito. O resolver autônomo deve relatar stall/falha e parar; nunca pode editar a worktree preservada, delegar reparo, publicar ou integrar por fora do controller. Um ID exato também pode continuar um run seletivo já concluído na próxima linha aberta do branch/worktree preservado; runs concluídos nunca são escolhidos implicitamente.

Durante um run Web, cada row selecionada mantém um card durável. `Running`, attempt e elapsed time ficam em elementos separados que não encolhem; somente a label longa sofre ellipsis, e o resultado terminal fecha o mesmo card. O controller geral possui card de background com status, timer e botão Stop. Timers locais não gravam eventos por segundo nem consomem tokens.

Runs Web terminam localmente por padrão. Linguagem humana explícita como `/leppy-loop continuar e publicar quando tudo passar` adiciona publicação remota ao grant de continuação; depois de um run local já concluído, `/leppy-loop publicar` seleciona o controller concluído autenticado mais recente e cria um grant somente de publicação sem reabrir trabalho. O modelo não pode acrescentar nem repetir essa autoridade, e workers continuam sem push ou `gh`. Instale e autentique o GitHub CLI (`gh auth status`) antes de optar pela publicação.

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
