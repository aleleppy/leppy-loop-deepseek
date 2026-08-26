import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { harnessRunDependencies } from './harness-runtime.js'
import { leppyCommand, optionsFromCommand } from './options.js'
import { runLeppyLoop } from './runner.js'

export const name = 'leppy-loop-startup'
export const inject = ['cmdlineArgs', 'llm', 'agentDefaultModel', 'credentials', 'settings']

export function apply(ctx: Context): void {
  const args = ctx.cmdlineArgs?.get() ?? []
  if (!args.some(argument => argument === '--tasks' || argument.startsWith('--tasks='))) return
  const command = leppyCommand()
  command.action(() => {
    const options = optionsFromCommand(command)
    void runLeppyLoop(options, harnessRunDependencies(ctx)).then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      ctx.appExit?.(result.status === 'completed' || result.status === 'dry-run' ? 0 : 1)
    }).catch(error => {
      process.stderr.write(`leppy-loop: ${error instanceof Error ? error.message : String(error)}\n`)
      ctx.appExit?.(1)
    })
  })
  parseCmdline(ctx, command)
}
