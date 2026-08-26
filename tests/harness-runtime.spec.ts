import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveWorkerCredential } from '../src/harness-runtime.js'

function context(providers: Record<string, Record<string, unknown>>, credentials: Record<string, string>): Context {
  return {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers } }],
    },
    credentials: {
      resolve: async (ref: string) => credentials[String(ref)] ? { value: credentials[String(ref)] } : undefined,
    },
  } as unknown as Context
}

describe('Harness provider credential routing', () => {
  it('keeps the native DeepSeek route on its declared credential', async () => {
    const credential = await resolveWorkerCredential(context({}, { DEEPSEEK_API_KEY: 'deepseek-key' }), 'deepseek-official')
    expect(credential).toEqual({ envName: 'DEEPSEEK_API_KEY', value: 'deepseek-key' })
  })

  it('resolves the selected pi-ai provider credential reference', async () => {
    const profile = { apiKeyEnv: 'OPENAI_CODEX_API_KEY', baseURL: 'https://example.invalid' }
    const credential = await resolveWorkerCredential(
      context({ 'openai-codex': profile }, { OPENAI_CODEX_API_KEY: 'codex-key' }),
      'openai-codex',
    )
    expect(credential).toEqual({ envName: 'OPENAI_CODEX_API_KEY', value: 'codex-key', providerProfile: profile })
  })

  it('preserves credential-store/OAuth providers without requiring DeepSeek', async () => {
    const credential = await resolveWorkerCredential(context({ 'openai-codex': {} }, {}), 'openai-codex')
    expect(credential).toEqual({ providerProfile: {} })
  })
})
