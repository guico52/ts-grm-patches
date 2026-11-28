import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      // `index.ts` only re-exports and `types.ts` is declarations only, so neither has
      // executable lines of its own. The modules they re-export are covered directly.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/types.ts'],
      // Measured baseline when the gate was introduced: 93.5% statements, 89.8% branches,
      // 93.6% functions, 94.8% lines. The gate sits a few points below so ordinary
      // refactors do not trip it, while a real drop in coverage fails CI.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
})
