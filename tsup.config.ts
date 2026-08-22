import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/startup.ts', 'src/worker-tool.ts', 'src/worker-host.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
})
