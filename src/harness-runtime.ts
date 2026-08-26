import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { RunDependencies } from './types.js'
import { publishPullRequest } from './publish.js'
import { HarnessWorkerAdapter } from './worker.js'

type ProviderProfile = Record<string, unknown> & { apiKeyEnv?: unknown }

function piAiProviderProfile(ctx: Context, provider: string): ProviderProfile | undefined {
  const section = ctx.settings.describe().find(descriptor => String(descriptor.ns) === 'llm-pi-ai')?.value as
    | { providers?: Record<string, ProviderProfile> }
    | undefined
  return section?.providers?.[provider]
}

export async function resolveWorkerCredential(ctx: Context, provider: string): Promise<{
  envName?: string
  value?: string
  providerProfile?: ProviderProfile
}> {
  if (provider === 'deepseek-official') {
    const envName = 'DEEPSEEK_API_KEY'
    const resolved = await ctx.credentials.resolve(credentialRef(envName))
    if (!resolved) throw new Error(`${envName} is not configured for the selected Harness provider ${provider}`)
    return { envName, value: resolved.value }
  }

  const providerProfile = piAiProviderProfile(ctx, provider)
  if (!providerProfile) {
    throw new Error(`selected Harness provider ${provider} has no llm-pi-ai profile that the isolated worker can reproduce`)
  }
  const envName = typeof providerProfile.apiKeyEnv === 'string' ? providerProfile.apiKeyEnv : undefined
  if (!envName) return { providerProfile }
  const resolved = await ctx.credentials.resolve(credentialRef(envName))
  if (!resolved) throw new Error(`${envName} is not configured for the selected Harness provider ${provider}`)
  return { envName, value: resolved.value, providerProfile }
}

/** Build the controller dependencies from the live Harness services. */
export function harnessRunDependencies(ctx: Context, signal?: AbortSignal): RunDependencies {
  return {
    worker: new HarnessWorkerAdapter({ credential: provider => resolveWorkerCredential(ctx, provider) }),
    defaultModel: async () => {
      const selection = ctx.agentDefaultModel.currentSelection()
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { effort: String(selection.reasoningEffort) } : {}),
      }
    },
    publishPullRequest,
    modelCatalog: async provider => {
      const listed = await ctx.llm.listModels(provider)
      return await Promise.all(listed.map(async model => {
        const resolved = await ctx.llm.resolveModelInfo(provider, model.id)
        return {
          id: model.id,
          ...(resolved.reasoning
            ? { reasoningEfforts: resolved.reasoning.efforts.map(effort => String(effort.id)) }
            : {}),
        }
      }))
    },
    ...(signal ? { signal } : {}),
  }
}
