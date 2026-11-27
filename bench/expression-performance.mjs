import assert from 'node:assert/strict'
import { log } from 'node:console'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EntityManager, dsl, model, prop } from '@ts-grm/core'
import { PostgresDriver, newSqlClient, spi as sqlSpi } from '@ts-grm/sql'

const modes = ['native', 'patched', 'patched-chain', 'enhanced-native', 'facade', 'chain', 'auto']
const mode = process.argv[2]
if (!mode) {
  const runs = []
  for (const name of process.env.BENCH_REVERSE === '1' ? [...modes].reverse() : modes) {
    const child = spawnSync(
      process.execPath,
      ['--expose-gc', fileURLToPath(import.meta.url), name],
      { encoding: 'utf8' },
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
        methodology:
          'Independent processes; 7 samples, median us/op; >=25ms samples; warmup; GC outside timing; 256 retained objects; real PostgreSQL renderer and empty executor; identical SQL/bindings asserted. fragments-prebuilt measures synchronous PreVisitor + FragmentGen without SQL stringification/executor. Native math/left use equivalent native SQL templates where upstream has no correct AST implementation.',
        runs,
      },
      null,
      2,
    ),
  )
} else {
  assert.ok(modes.includes(mode))
  const patch = mode === 'native' ? undefined : await import('ts-grm-patches')
  const installStart = performance.now()
  patch?.applyPatches()
  const installMs = performance.now() - installStart
  const Sale = model(
    'ExpressionBenchSale',
    'id',
    class {
      id = prop.i32()
      name = prop.str(50)
      amount = prop.i32()
    },
  )
  const sql = []
  let capturing = true
  const driver = new PostgresDriver({})
  Object.defineProperty(driver, 'transactionManager', {
    value: {
      executeReadonly: (fn) => fn(),
      defaultExecutor: {
        async executeStatement(text, args) {
          if (capturing) sql.push({ text, values: args.map((arg) => arg.value) })
          return []
        },
      },
    },
  })
  const raw = newSqlClient(driver, { entityManager: EntityManager.combine(Sale, Sale) })
  const client =
    mode === 'native' || mode === 'patched' || mode === 'patched-chain'
      ? raw
      : patch.enhanceClient(raw)
  let table
  client.createQuery(Sale, (q, t) => {
    table = t
    return q.select(t.id)
  })
  const expressions = {
    math: (t) =>
      mode === 'facade'
        ? client.fn.round(client.fn.abs(client.fn.sum(t.amount)), 2)
        : mode === 'patched-chain' || mode === 'chain' || mode === 'auto'
          ? t.amount.sum().abs().round(2)
          : dsl.native.num`round(cast(abs(${dsl.sum(t.amount)}) as numeric), ${2})`,
    trim: (t) => (mode === 'facade' ? client.fn.trim(t.name).upper() : t.name.trim().upper()),
    left: (t) =>
      mode === 'native'
        ? dsl.native.str`left(${t.name}, ${3})`
        : mode === 'facade'
          ? client.fn.left(t.name, 3)
          : t.name.left(3),
  }
  const build = (expression) =>
    client.createQuery(Sale, (q, t) => {
      if (mode === 'auto') q.autoGroupBy()
      return q.select(expression(t))
    })
  const cases = []
  for (const [name, expression] of Object.entries(expressions)) {
    const prebuilt = build(expression)
    await prebuilt.fetchList()
    cases.push(
      [`${name}:expression`, () => expression(table), false],
      [`${name}:build`, () => build(expression), false],
      // Public native SPI: no BaseQuery metadata is needed for these root-table queries.
      [`${name}:fragments-prebuilt`, () => sqlSpi.Composite.of(prebuilt, client, undefined), false],
      [`${name}:render-prebuilt`, () => prebuilt.fetchList(), true],
      [`${name}:build-render`, () => build(expression).fetchList(), true],
    )
  }
  capturing = false
  const retained = new Array(256)
  let sink
  async function timed(fn, async, count) {
    const start = performance.now()
    if (async) for (let i = 0; i < count; i++) retained[i & 255] = sink = await fn()
    else for (let i = 0; i < count; i++) retained[i & 255] = sink = fn()
    return performance.now() - start
  }
  const results = {}
  for (const [name, fn, async] of cases) {
    await timed(fn, async, 500)
    let count = 128
    let elapsed = await timed(fn, async, count)
    while (elapsed < 20 && count < 131072) {
      count *= 2
      elapsed = await timed(fn, async, count)
    }
    count = Math.max(64, Math.ceil((count * 25) / Math.max(elapsed, 1)))
    const samples = []
    for (let i = 0; i < 7; i++) {
      globalThis.gc?.()
      samples.push(((await timed(fn, async, count)) * 1000) / count)
    }
    const ordered = [...samples].sort((a, b) => a - b)
    results[name] = { medianUs: ordered[3], minUs: ordered[0], maxUs: ordered[6], count }
  }
  assert.ok(sink !== undefined)
  log(JSON.stringify({ mode, installMs, sql, results }))
}
