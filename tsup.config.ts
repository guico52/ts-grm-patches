import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/postgres.ts',
    'src/mysql.ts',
    'src/sqlite.ts',
    'src/sqlserver.ts',
    'src/oracle.ts',
  ],
  format: ['esm', 'cjs'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  // All entry points must share client bindings and expression metadata in CJS
  // as well as ESM; independently bundled runtimes would lose those WeakMaps.
  splitting: true,
  clean: true,
  treeshake: true,
})
