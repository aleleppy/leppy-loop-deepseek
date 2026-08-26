import { defineConfig } from 'tsup'

const MODULE_ID = 'leppy-loop-deepseek'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: ['cjs'],
  outExtension: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: false,
  injectStyle: true,
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(MODULE_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})
