import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-credentials'
import { HarnessWorkerAdapter } from './worker.js'
import { leppyCommand, optionsFromCommand } from './options.js'
import { runLeppyLoop } from './runner.js'

export const name = 'leppy-loop-startup'
export const inject = ['cmdlineArgs', 'llm', 'agentDefaultModel', 'credentials']

export function apply(ctx: Context): void {
  const command = leppyCommand()
  command.action(() => {
    const options = optionsFromCommand(command)
    const selection = ctx.agentDefaultModel.currentSelection()
    const worker = new HarnessWorkerAdapter({ credential: async () => {
      const resolved = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
      if (!resolved) throw new Error('DEEPSEEK_API_KEY is not configured in the Harness credential service')
      return resolved.value
    } })
    void runLeppyLoop(options, {
      worker,
      defaultModel: async () => ({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { effort: String(selection.reasoningEffort) } : {}) }),
      modelCatalog: async provider => {
        const listed = await ctx.llm.listModels(provider)
        return await Promise.all(listed.map(async model => {
          const resolved = await ctx.llm.resolveModelInfo(provider, model.id)
          return { id: model.id, ...(resolved.reasoning ? { reasoningEfforts: resolved.reasoning.efforts.map(effort => String(effort.id)) } : {}) }
        }))
      },
    }).then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      ctx.appExit?.(result.status === 'completed' || result.status === 'dry-run' ? 0 : 1)
    }).catch(error => {
      process.stderr.write(`leppy-loop: ${error instanceof Error ? error.message : String(error)}\n`)
      ctx.appExit?.(1)
    })
  })
  parseCmdline(ctx, command)
}
