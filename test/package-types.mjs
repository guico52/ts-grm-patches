import process from 'node:process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = mkdtempSync(join(root, '.package-types-'))
try {
  for (const entry of ['', '/postgres', '/mysql', '/sqlite', '/sqlserver', '/oracle']) {
    const fixture = join(temporary, 'consumer.mts')
    writeFileSync(
      fixture,
      `
import type {} from 'ts-grm-patches${entry}'
import { dsl } from '@ts-grm/core'
import type { NumExpression, StrExpression } from '@ts-grm/core'
const value: NumExpression<number> = dsl.native.num\`1\`.sum().abs().round(2).coalesce(0)
const name: StrExpression<string> = dsl.native.str\`'a'\`.min().trim().coalesce('')
const predicate = value.eq(1).and(undefined).not()
// @ts-expect-error Numeric expressions cannot receive logical chains.
value.and(predicate)
void name
`,
    )
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        fixture,
      ],
      { encoding: 'utf8' },
    )
    if (result.status !== 0)
      throw new Error(`${entry || 'root'} declarations: ${result.stdout}${result.stderr}`)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
