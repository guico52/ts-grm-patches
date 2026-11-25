import assert from 'node:assert/strict'
import { log } from 'node:console'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EntityManager, dsl, model, prop } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

// Separate processes prevent the globally installed metadata patch and V8's
// polymorphic call sites from leaking into the native control.
const modes = [
  'native',
  'imported',
  'patched',
  'enhanced-native',
  'enhanced-functions',
  'enhanced-auto',
]
const mode = process.argv[2]
if (!mode) {
  const runs = []
  const order = process.env.BENCH_REVERSE === '1' ? [...modes].reverse() : modes
  for (const name of order) {
    const child = spawnSync(
      process.execPath,
      ['--expose-gc', fileURLToPath(import.meta.url), name],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
    )
    if (child.status !== 0) throw new Error(child.stderr || child.stdout)
    runs.push(JSON.parse(child.stdout))
  }
  runs.sort((a, b) => modes.indexOf(a.mode) - modes.indexOf(b.mode))
  for (const run of runs)
    assert.deepEqual(run.sql, runs[0].sql, `${run.mode}: SQL/bindings changed`)
  log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: cpus()[0]?.model,
        },
        methodology:
          '7 samples, median microseconds per operation; >=40 ms per sample; warmup; GC outside timing; independent processes; native PostgreSQL renderer + empty mock executor; identical SQL and bindings checked',
        runs,
      },
      null,
      2,
    ),
  )
} else {
  assert.ok(modes.includes(mode))
  const patch = mode === 'native' ? undefined : await import('ts-grm-patches')
  if (mode !== 'native' && mode !== 'imported') patch.applyPatches()
  const enhanced = mode.startsWith('enhanced-')
  const useFunctions = mode === 'enhanced-functions' || mode === 'enhanced-auto'
  const automatic = mode === 'enhanced-auto'
  const Sale = model(
    'BenchSale',
    'id',
    class {
      id = prop.i32()
      name = prop.str(50)
      amount = prop.i32()
      enabled = prop.bool()
      description = prop.text()
    },
  )
  const manager = EntityManager.combine(Sale, Sale)
  const sql = []
  let capture = true
  const driver = new PostgresDriver({})
  Object.defineProperty(driver, 'transactionManager', {
    value: {
      executeReadonly: (fn) => fn(),
      defaultExecutor: {
        async executeStatement(text, args) {
          if (capture) sql.push({ text, values: args.map((arg) => arg.value) })
          return []
        },
      },
    },
  })
  const createClient = () => {
    const client = newSqlClient(driver, { entityManager: manager })
    return enhanced ? patch.enhanceClient(client) : client
  }
  const client = createClient()
  const simple = () =>
    client.createQuery(Sale, (q, t) => {
      q.where(t.id.gt(0))
      if (automatic) q.autoGroupBy()
      return q.select({ id: t.id, name: t.name })
    })
  const grouped = () =>
    client.createQuery(Sale, (q, t) => {
      const key = useFunctions ? q.fn.lower(t.name).upper() : t.name.lower().upper()
      const total = useFunctions ? q.fn.sum(t.amount).plus(1) : dsl.sum(t.amount).plus(1)
      q.where(t.id.gt(0))
      if (automatic) q.autoGroupBy()
      else q.groupBy(key)
      return q.select({ key, total })
    })
  await simple().fetchList()
  await grouped().fetchList()
  capture = false
  let table
  client.createQuery(Sale, (q, t) => {
    table = t
    return q.select(t.id)
  })
  const expression = () =>
    useFunctions ? client.fn.sum(table.amount).plus(1) : dsl.sum(table.amount).plus(1)
  let sink
  // Retain a ring of results so all constructed objects escape the timed loop.
  const retained = new Array(256)
  const timed = async (fn, async, count) => {
    const start = performance.now()
    if (async) for (let i = 0; i < count; i++) retained[i & 255] = sink = await fn()
    else for (let i = 0; i < count; i++) retained[i & 255] = sink = fn()
    return performance.now() - start
  }
  const results = {}
  const cases = [
    ['client-create', createClient, false],
    ['expression', expression, false],
    ['build-simple', simple, false],
    ['build-grouped', grouped, false],
    ['render-simple', () => simple().fetchList(), true],
    ['render-grouped', () => grouped().fetchList(), true],
  ]
  if (mode !== 'native' && mode !== 'imported') {
    cases.push(
      [
        'build-bool-text',
        () =>
          client.createQuery(Sale, (q, t) =>
            q.select({ enabled: t.enabled, description: t.description }),
          ),
        false,
      ],
      ['read-cached-bool-text', () => table.enabled === table.description, false],
    )
  }
  for (const [name, fn, async] of cases) {
    await timed(fn, async, 500)
    let count = 128
    let elapsed = await timed(fn, async, count)
    while (elapsed < 25 && count < 131072) {
      count *= 2
      elapsed = await timed(fn, async, count)
    }
    count = Math.max(64, Math.ceil((count * 40) / Math.max(elapsed, 1)))
    const samples = []
    for (let sample = 0; sample < 7; sample++) {
      globalThis.gc?.()
      samples.push(((await timed(fn, async, count)) * 1000) / count)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    results[name] = { medianUs: sorted[3], minUs: sorted[0], maxUs: sorted[6], count }
  }
  assert.ok(sink !== undefined)
  log(JSON.stringify({ mode, sql, results }))
}
