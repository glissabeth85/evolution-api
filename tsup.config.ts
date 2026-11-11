import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src'],
  outDir: 'dist',
  splitting: false,
  // Source maps can be disabled on low-memory build hosts with TSUP_SOURCEMAP=false.
  sourcemap: process.env.TSUP_SOURCEMAP !== 'false',
  clean: true,
  minify: true,
  // Only CJS: the app runs `node dist/main` (CommonJS). The ESM output was never used and
  // doubled build time and peak memory (~2.5 GB), which got builds OOM-killed on small servers.
  format: ['cjs'],
  onSuccess: async () => {
    cpSync('src/utils/translations', 'dist/translations', { recursive: true });
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
