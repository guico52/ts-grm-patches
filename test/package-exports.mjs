import assert from 'node:assert/strict'
import { log } from 'node:console'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cases = [
  ['postgres', 'PostgresDriver', (fn) => fn.postgres.jsonbExtractPathText('{}', 'name')],
  ['mysql', 'MySqlDriver', (fn) => fn.mysql.jsonUnquote('"name"')],
  ['sqlite', 'SqliteDriver', (fn) => fn.sqlite.jsonType('{}')],
  ['sqlserver', 'SqlServer2012Driver', (fn) => fn.sqlserver.jsonValue('{}', '$.name')],
  ['oracle', 'Oracle12Drivier', (fn) => fn.oracle.toChar(1)],
]

// Real package exports, not source imports: CJS entry points must share the
// same binding/metadata runtime as the root entry, just as ESM entry points do.
for (const [mode, load] of [
  ['ESM', (name) => import(name)],
  ['CJS', (name) => require(name)],
]) {
  const root = await load('ts-grm-patches')
  const core = await load('@ts-grm/core')
  const sql = await load('@ts-grm/sql')
  for (const [family, className, expression] of cases) {
    const entry = await load(`ts-grm-patches/${family}`)
    const Model = core.model(
      `PackageBinding${mode}${family}`,
      'id',
      class {
        id = core.prop.i32()
      },
    )
    const statements = []
    const driver = new sql[className]({})
    Object.defineProperty(driver, 'transactionManager', {
      value: {
        executeReadonly: (fn) => fn(),
        defaultExecutor: {
          async executeStatement(text) {
            statements.push(text)
            return []
          },
        },
      },
    })
    const client = entry.newSqlClient(driver, {
      entityManager: core.EntityManager.combine(Model, Model),
    })
    const expr = expression(client.fn)
    assert.equal(root.getFunctionMetadata(expr).dialect, family)
    const derived = root.newSqlClient(client)
    assert.equal(derived.dialect, family)
    assert.equal(entry.enhanceClient(derived), derived)
    const chain = expr.coalesce('fallback').upper()
    await derived
      .createQuery(Model, (q, t) => q.select({ id: t.id, value: chain }).where(t.id.gt(0)))
      .fetchList()
    assert.equal(statements.length, 1)
    assert.match(statements[0], /upper\(coalesce\(/)
    assert.equal(Object.isFrozen(derived.dialectProfile), true)
  }
  log(`${mode}: all five package entry points share bindings, metadata and function chains`)
}
