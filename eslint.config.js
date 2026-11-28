import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url))

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    // Node globals for the .mjs helpers (scripts, package-contract tests, benches).
    // They sit outside the TypeScript project, so this block keeps the
    // non-type-aware rule set. `globals.node` is used rather than a hand-written
    // list so a new Node API never needs an eslint config change.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Type-aware rules catch what the recommended set cannot see: floating promises,
    // awaiting non-promises, and lost `this` bindings. The `no-unsafe-*` family is
    // disabled on purpose: this package deliberately reads upstream SPI members that are
    // typed `any`, and annotating every boundary there would add noise without safety.
    // The remaining rules are the ones that have caught real bugs here.
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
)
