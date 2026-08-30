# Leppy Loop para DeepSeek Harness

[English](README.md)

Leppy Loop é um bundle Cordis externo e nativo que executa uma checklist Markdown rastreada com um processo e uma sessão novos do DeepSeek Harness por linha de worker. O controller é dono do Git, worktree, transições da checklist, closure, gates, recuperação durável e leases de processo.

A versão `0.3.23` é fixada no DeepSeek Harness `0.1.1-rc.2`, commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e). Ela registra o comando Host, uma tool durável de controller sempre descobrível, a skill model-only `leppy-loop-operator`, sem colisão com o comando humano, e cards Web sem patch do Harness.

## Instalação

Requer Node `22.19+`, Git e pnpm `10.28.1`. O DeepSeek Harness repassa a gestão de plugins ao `pnpm` encontrado no `PATH`; pnpm 11 exige aprovação separada de builds nativos e não é uma combinação de instalação afirmada para `0.3.23`. Configure a credencial do provedor selecionado na página Models do Harness, gere o pacote e instale no profile usado pelo Web host. Os workers reutilizam automaticamente o provedor, o perfil do modelo e a credencial selecionados; `DEEPSEEK_API_KEY` não é necessária quando outro provedor está ativo:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add ./leppy-loop-deepseek-0.3.23.tgz
```

Reinicie o processo `dsh web` existente depois de alterar o profile. Refresh do navegador não compõe um plugin Host recém-instalado. Um tarball publicado no GitHub Release pode substituir o path do `.tgz` local; não há afirmação de publicação em registry de plugins.

## Uso rápido

Abra uma sessão Web no repositório e autorize um lifecycle com linguagem humana comum — nunca paths, base, run ID, fingerprint, scope, ciclos ou flags de repair:

```text
/leppy-loop
/leppy-loop conclua a adoção de capabilities e abra um PR
/leppy-loop rode somente local; não publique
/leppy-loop status
/leppy-loop parar
```

O slash command retorna depois de criar um permit de lifecycle e enfileirar um turno curto da IA. O mesmo permit conduz até dezesseis transições sequenciais de um único run/sessão/repositório: a IA pode retomar falhas recuperáveis, escolher repair limitado, reconciliar publicação e reagir ao fim do background sem pedir comandos separados por fase. Só uma transição fica em voo. Depois de preso ao run, o permit usa marker HMAC obrigatório, recibos encadeados e head monotônico autenticado: admissão persiste antes do job, downgrade local-only antes do ack do slash e revogação de Stop antes do kill. Após restart do Host ele reidrata; authority moderna corrompida entra em quarentena, `run.json` mutável nunca concede autoridade e transição consumida não volta após crash. O permit ainda expira em 24 horas, não cruza sessão/repo/run e nunca autoriza ampliar scope, merge ou deploy. Linguagem explícita `não publique`/somente local remove de forma imutável a autoridade de push/PR; caso contrário, `/leppy-loop` autoriza a IA a decidir pela conversa se a entrega normal inclui branch e PR do controller.

A tool global `leppy_loop_control` recebe checklist/base/run/recovery/publicação técnicos enquanto a superfície humana permanece simples. O `preflight` read-only valida scopes canônicos e base antes de criar worktree. A tool prende o permit ao primeiro run uma única vez, valida cada continuação contra o controller HMAC vivo, usa orçamento cumulativo e transfere cada transição para `ctx.jobs` preso ao owner. `status` nunca confia em job lembrado e só expõe controller durável à sessão assinada: estado `running` sem job Host do owner vira `orphaned`, sem ID inventado. Fingerprints de gate, worktree limpa, scope de closure, recibos e ciclos limitados permanecem controller-side; workers continuam sem push ou `gh`.

A política padrão `adaptive` usa `gpt-5.6-terra` com esforço `high` nas tarefas comuns do OpenAI Codex e muda para `gpt-5.6-sol` com esforço `low` nas closures e na recuperação de uma tarefa parada. Notificações terminais do SDK por overload, indisponibilidade temporária, rate limit e HTTP 502/503 continuam sendo falhas de disponibilidade mesmo quando o SDK resolve com resposta final vazia: recebem uma vez o fallback de disponibilidade e depois param com recibo recuperável. Elas nunca entram na verificação de zero commits. Uma tarefa comum realmente concluída com árvore limpa e zero commits recebe automaticamente uma única nova tentativa pela política de recuperação. Se essa tentativa independente provar que o contrato `Done:` já está satisfeito pelo marcador terminal exato e deixar o branch limpo e inalterado, o controller fecha somente a checklist; WIP sujo, evidência ausente e zero commits repetido sem verificação continuam falhando de forma fechada. Metadados `model=`/`effort=` na linha e opções CLI `--model`/`--effort` têm prioridade. Use `--worker-policy selected`, `terra-high` ou `sol-low` para escolher outro comportamento global. O limite padrão de transcript é 8192 KiB e pode ser alterado com `--worker-transcript-limit-kb`. Os recibos de retomada incluem `--recover-run <id>` para evitar ambiguidade quando ainda existem runs antigos com falha. A retomada autenticada exata resolve e valida o controller na worktree preservada do run, portanto o checkout fonte pode ter mudado de branch, removido a checklist ou conter alterações sujas não relacionadas; runs novos continuam exigindo checkout fonte limpo e checklist tracked. Um gate que falhou pode reservar retry ou repair limitado no mesmo permit de lifecycle; a tool restrita reconstrói o run exato e o controller aceita somente o mesmo fingerprint. O reparo recusa worktree suja, cria commit de reabertura, permanece no scope existente da closure e consome os limites fixos de repair/transições. Quando o gate provar que a closure original omitiu artefatos gerados ou dependências necessárias, uma pessoa pode adicionar scopes existentes na worktree com `--repair-path <path...>`; as adições são validadas, persistidas, registradas e concedidas somente ao worker de reparo reaberto. Comandos na raiz podem omitir `cwd` ou usar `cwd="."`, enquanto a validação do commit continua limitada ao scope efetivo. Uma invocação direta de reparo encadeia por padrão até três ciclos de closure nova/gate, entregando cada novo recibo vermelho ao worker seguinte; `--repair-cycles <1..8>` altera esse limite rígido. O processo para imediatamente em sucesso, falha do worker, estado sujo, fingerprint alterado, cancelamento ou esgotamento, sem loop infinito. O resolver autônomo deve relatar stall/falha e parar; nunca pode editar a worktree preservada, delegar reparo, publicar ou integrar por fora do controller. Um ID exato também pode continuar um run seletivo já concluído na próxima linha aberta do branch/worktree preservado; runs concluídos nunca são escolhidos implicitamente.

Todo worker termina com um `LEPPY_OUTCOME` estruturado. `completed` exige evidência concreta de validação `passed`; report ausente/malformado, `blocked`, validação falha ou prosa contraditória como `BLOQUEADO` deixam a row aberta. Três falhas idênticas de tool ou oito falhas totais encerram o turno; bloqueio/indisponibilidade/falha repetida também abrem um circuito durável contra follow-up automático. Uma falha npm determinística `ENOTCACHED`/`only-if-cached` ou `MODULE_NOT_FOUND` sob `node_modules` encerra já na primeira tool. O attempt global é persistido antes de spawnar cada retry.

Quando um worker de tarefa comum cria exatamente um commit limpo dentro do scope mas não consegue executar a validação focada, o controller preserva esse avanço material como validação pendente autenticada por HMAC, em vez de abrir o circuito de tentativa inalterada ou lançar outro worker de implementação. O commit exato é verificado em uma worktree detached descartável, com tools read/search/exec e sem write/edit/commit/delete. O verifier nega package managers, scripts do repositório, shells e frontends de interpretadores; o binário simples de validação precisa resolver do `node_modules/.bin` autenticado da raiz. Antes da adoção, o controller prova HEAD/index/árvore tracked intactos na cópia e WIP durável, digest de bytes ignored e checklist ainda idênticos. Um report com pass entra na mesma geração atômica de `run.json` e é adotado exatamente uma vez por amend somente da checklist, reconciliável após crash. Validação que falhou continua falha, e verificação indisponível/repetida continua fail-closed. A retomada após interrupção pós-commit só entra nesse caminho enquanto tarefa, checklist, base, commit e scope autenticados ainda coincidem.

Antes de liberar um worker, o próprio controller materializa uma árvore npm utilizável. Primeiro ele prefere um `node_modules` da fonte equivalente e estruturalmente atual como fronteira explícita de estado local confiável. Se essa cópia não existir, um único lock npm sem workspaces, com pacotes presos a origens HTTPS sem credenciais e digests de integridade suportados, pode ser instalado pelo `npm-cli.js` do próprio Host em staging privado; filhos `inBundle` só são aceitos por uma cadeia recursiva de declarações explícitas que termina nesse tarball com integridade. Esse `npm ci` usa config/cache isolados, ambiente allowlisted, sem lifecycle scripts/audit/funding, cancelamento da árvore de processos e quotas vivas de arquivos/bytes/profundidade. Os dois caminhos recusam pacotes, shims ou payloads ocultos inesperados, links externos e hardlinks, validam a árvore completa e normalmente publicam sem substituir ou apagar target. Para uma condição autenticada `ENOTCACHED` ou módulo ausente, o runner sob lock do repositório pode mover atomicamente um target inválido para quarentena, materializar o lock exato da worktree, publicar e validar uma nova árvore física e então descartar a quarentena. Uma transação durável presa à identidade só adota a fase `published`, gravada após validação; fases anteriores de crash/falha preservam a quarentena original, removem apenas target comprovadamente pertencente ao controller e repetem sem jamais restaurar por cima, apagar ou substituir uma corrida não pertencente ao controller. Receipt de transação pendente bloqueia worker de forma independente, e erros de setup preservam o contexto autenticado do dependency miss necessário para retomar a mesma transação. Esse reparo exige o digest exato do erro atual sob a mesma autoridade persistida antes de outro worker iniciar.

A resolução de executável do worker antepõe somente o `node_modules/.bin` da raiz autenticada, resolve o comando exato pelo subprocess service do Host e executa esse path com o mesmo ambiente limpo dentro de sandbox cuja raiz canônica deve ser a worktree. Gerenciadores de pacote são fail-closed para scripts explícitos via `run`/`test`; frontends dinâmicos (`npx`, `bunx`, `pnpx`, `yarnpkg`, `corepack`), mutação de dependências e overrides de cache local são negados. Fora disso, o worker chama ferramentas já materializadas pelo nome simples. Se uma falha `npx` anterior autenticada deixou `.npm-cache` físico, totalmente untracked e fora do scope da tarefa, o controller sob lock pode mover o diretório — sem apagar seus bytes — para uma transação de quarentena autenticada por HMAC e presa à identidade antes de retomar o WIP preservado. Tentativas novas exigem baseline assinado provando ausência antes do worker; runs legados exigem o digest exato da falha atual e o run ID exato. Cache tracked, staged, linkado, ambíguo, recriado ou com identidade alterada falha fechado; estado de artefato em outro filesystem é recusado antes de existir receipt. Toda fase de receipt é reconciliada antes de liberar worker e um crash retoma a mesma transação.

Durante um run Web, cada row selecionada mantém um card durável. `Running`, attempt por tarefa e elapsed time ficam em elementos separados que não encolhem; somente a label longa sofre ellipsis, e o resultado terminal fecha o mesmo card. Rows sequenciais e subtarefas substitutas criadas por um split durável começam em `Attempt 1`; recovery explícito da mesma row inalterada avança seu ordinal local. A identidade global separada continua cumulativa em leases, recibos, eventos e recovery limitado. O controller geral possui card de background com status, timer e botão Stop. `/leppy-loop status` mostra primeiro o job ativo exato preso ao owner; estado durável `running` sem esse job é `orphaned`, nunca um `leppy-loop-*` chutado. Sem job ativo, mostra o controller autenticado mais recente mesmo quando a parada ocorreu na publicação. Stalls resolvidos preservam o detalhe acionável limitado em vez de virar uma falha genérica. Timers locais não gravam eventos por segundo nem consomem tokens.

A publicação primeiro deriva um único repositório GitHub de URLs fetch/push coincidentes e reconcilia um PR OPEN ou MERGED exato, do mesmo owner, antes de rebase, gate ou push; para MERGED pode fazer fetch somente leitura para provar que o merge commit ainda está na base viva solicitada. Sem PR, faz prune e consulta refs remotas vivas em vez de confiar em tracking branch stale. Base configurada apagada falha fechada; a IA pode fornecer uma branch substituta técnica dentro do mesmo lifecycle, nunca outro remote, aceita somente quando um target anterior durável está incorporado nela. A reconciliação de PR OPEN ou MERGED aplica a mesma regra de base/ancestralidade. Fetch, `ls-remote` e push usam as URLs literais validadas em vez de alias remoto mutável. Branch do controller já enviada só é atualizada com `force-with-lease` preso ao OID observado; base, remote head, worktree limpa e HEAD validado pelo gate são conferidos imediatamente antes do push e o remote head é verificado depois. A busca por PR repete antes do create para absorver corrida.

Se o rebase por OID exato parar em conflitos, no máximo três workers frescos recebem somente read/write/delete nos arquivos não mesclados exatos, sem commit ou exec. O controller congela HEAD e index, recusa drift/edição fora de scope, faz stage dos conflitos, pula replay vazio com segurança e repete o gate final. Reconciliar PR exato já existente não faz mutação remota e permite fechar o estado durável depois de abertura/merge manual. Workers não fazem push nem usam `gh`; Leppy nunca faz merge ou deploy. Instale e autentique o GitHub CLI (`gh auth status`) antes de permitir publicação.

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

Tarefa comum exige `Done:` não vazio e paths canônicos repo-relative explícitos, preferencialmente em `paths=` (crases são fallback compatível). Fragmentos como `.ui`, braces/globs, basename inferido que só existe aninhado e tarefa que exige testes sem scope de teste falham no preflight. O formato canônico com pipes é preferido, mas continua compatível com continuações Markdown indentadas e as formas históricas `[closure]`/`[gate]`, `Paths:`, `Paths EXATOS:`, `Paths permitidos:` e `Done:` multiline. Um checkpoint `[?] [human]` ou `[?] [human/live]` nunca inicia worker: o run para com o worktree preservado até um humano marcar a row e recuperar o ID exato. A capability de commit faz stage somente dos arquivos alterados exatos já validados; um arquivo ignorado e não rastreado só é elegível quando está sob um desses escopos explícitos, permitindo migrations intencionalmente versionadas sem varrer material ignorado não relacionado. `--task-match` é substring literal. Paths passam por `realpath`; traversal, absoluto e symlink/junction escapando do repositório são recusados. O worker nunca pode ler ou editar a checklist controladora.

Um `.leppy-loop.json` rastreado na raiz pode fornecer `customInstructions` string, anexada às instruções `AGENTS.md`/`CLAUDE.md` aplicáveis. Shapes inválidos falham fechados; o arquivo tem limite de 64 KiB e a string, 32 KiB. Dry-run expõe todos os diagnósticos de lint na ferramenta do modelo e no texto do comando direto.

## Semântica

O checkout e a checklist rastreada precisam estar limpos. O controller faz no máximo um fetch, resolve `--sync-branch`, cria uma branch `leppy-loop/<tasks>-<run-id>` e uma worktree irmã. Não sincroniza de novo durante o loop.

Cada tarefa recebe um processo/sessão efêmero, precisa reportar validação estruturada `passed` e deixar exatamente um commit conventional com árvore limpa. Closure também exige report `passed` e pode deixar um commit corretivo ou um no-op limpo validado; closure bloqueada permanece aberta. Gate não cria worker: o controller roda o comando opaco uma vez, grava recibo e marca a linha. Falha/crash de gate nunca repete sozinho.

Defaults: sync 120 s, worker 30 min, 64 inicializações, output final 192 KiB e transcript 8 MiB. Provider/model/effort vêm da seleção atual do Harness, são validados no catálogo real, e o fallback ocorre uma vez apenas por indisponibilidade/rate limit.

## Recuperação

Estado durável fica fora da worktree: `run.json`, PID do runner, eventos JSONL, outputs, transcripts, recibos, resumos de diff, instrução de retomada, prova de ownership e leases HMAC. Há um lock por `git-common-dir`.

Timeout, limite ou Ctrl+C preserva WIP e a mesma linha. Retome com `--recover-existing-wip`. O controller só adota um único run autenticado correspondente. Só encerra uma árvore quando lease, PID e identidade de início ainda coincidem; nunca busca ou mata por nome.

## Segurança e limitações

É isolamento prático, não absoluto. Worker comum pode ler a worktree exceto a checklist controladora, mas writes continuam presos aos scopes. `leppy_search` e `leppy_edit` substituem loops de shell/patch. Comandos usam argv exato sob `workspace-write`; PowerShell só é aceito como `-File` para `.ps1` repo-local e Git tem allowlist positiva read-only. Clientes remotos, push, `gh`, publicação, deploy, mutação de PR, integração/worktree e avaliação dinâmica são negados. A chave vem do serviço de credenciais e subprocessos de ferramenta recebem ambiente scrubbed; logs/eventos são redigidos.

Commit em Git worktree grava no `git-common-dir`, fora da raiz do sandbox. Por isso existe uma capability estreita `leppy_commit`: ela valida todos os arquivos alterados, stageia somente os escopos declarados e aceita apenas mensagem conventional. Ela não expõe Git geral.

O sandbox oficial não confina rede. Um script malicioso já presente no repositório pode usar rede durante um teste permitido. Não use em repositório não confiável. Push, PR, release, publicação e deploy nunca são automáticos.

Leppy difere de Ralph porque a checklist tipada é a máquina de estados controlada: uma linha por sessão, escopo de paths, validação Git, closure e gate explícitos. O contexto independente aumenta o custo porque conversa/cache não é compartilhada.

Para todos os flags, eventos, troubleshooting, API e desenvolvimento, veja o [README em inglês](README.md), [ARCHITECTURE.md](ARCHITECTURE.md) e [THREAT_MODEL.md](THREAT_MODEL.md).

## Licença

Apache-2.0.
