import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(HERE, 'twin'),
  base: './',
  publicDir: false,
  plugins: [viteSingleFile({ removeViteModuleLoader: true, useRecommendedBuildConfig: false })],
  build: {
    outDir: resolve(HERE, 'twin_dist'),
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    target: 'es2020',
    minify: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
