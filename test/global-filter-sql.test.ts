import { EntityManager, dsl, model, prop } from '@ts-grm/core'
import type { SqlClient } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'
import type { FilterManager } from '@ts-grm/sql'
import { describe, expect, it } from 'vitest'

import { createGlobalFilterManager } from '../src/index'

const STORE = model(
  'SqlStore',
  'id',
  class {
    id = prop.i32()
    name = prop.str(30)
  },
)

const BOOK = model(
  'SqlBook',
  'id',
  class {
    id = prop.i32()
    name = prop.str(30)
  },
)

// 只有 STORE 有 tenantId，BOOK 没有
const TENANT = model(
  'SqlStoreWithTenant',
  'id',
  class {
    id = prop.i32()
    tenantId = prop.i32()
  },
)

interface QueryConfig {
  readonly text: string
  readonly values: ReadonlyArray<unknown>
}

/**
 * 捕获真实 SQL，但不连接数据库。
 *
 * executor 由 `driver.transactionManager` 创建（`sql_client_impl.ts:346`），所以要在
 * driver 的 pool 这一层模拟：把 `query()` 收到的 `{ text, values }` 记下来并返回空结果集。
 */
function capturingClient(filterManager?: FilterManager): {
  client: SqlClient
  statements: string[]
} {
  const statements: string[] = []
  const record = (config: QueryConfig): unknown => {
    statements.push(config.text)
    return { rows: [], rowCount: 0, fields: [] }
  }
  const pool = {
    async connect() {
      return { query: record, release() {} }
    },
    query: record,
    async end() {},
  }

  const client = newSqlClient(new PostgresDriver(pool as never), {
    entityManager: EntityManager.combine(
      EntityManager.combine(STORE as never, BOOK as never),
      TENANT as never,
    ),
    ...(filterManager == null ? {} : { filterManager }),
  })
  return { client, statements }
}

const selectBooks = (client: SqlClient): Promise<unknown> =>
  client.createQuery(BOOK, (q, b) => q.select(b.id, b.name)).fetchList()

const selectBooksWithSubQuery = (client: SqlClient): Promise<unknown> =>
  client
    .createQuery(BOOK, (q, b) =>
      q
        .where(b.id.inSubQuery(dsl.subQuery(BOOK, (sq, sb) => sq.select(sb.id))))
        .select(b.id, b.name),
    )
    .fetchList()

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

describe('global filters in generated SQL', () => {
  it('没有过滤器时不产生 where 条件', async () => {
    const { client, statements } = capturingClient()
    await selectBooks(client)

    expect(statements).toHaveLength(1)
    const sql = normalize(statements[0]!)
    expect(sql).toContain('select tb_1_.ID, tb_1_.NAME from')
    expect(sql).not.toContain('where')
  })

  it('过滤器进入主查询的 where', async () => {
    const manager = await createGlobalFilterManager([BOOK])
    manager.addGlobalFor('name', (t) => (t as { eq(v: unknown): never }).eq('x'))

    const { client, statements } = capturingClient(manager)
    await selectBooks(client)

    expect(normalize(statements[0]!)).toContain('where tb_1_.NAME = $1')
  })

  it('子查询里也应用过滤器（主查询与子查询各一次）', async () => {
    const manager = await createGlobalFilterManager([BOOK])
    manager.addGlobalFor('name', (t) => (t as { eq(v: unknown): never }).eq('x'))

    const { client, statements } = capturingClient(manager)
    await selectBooksWithSubQuery(client)

    const sql = normalize(statements[0]!)
    // 子查询内部（tb_2_）与主查询（tb_1_）各应用一次
    expect(sql).toContain('in(select tb_2_.ID from')
    expect(sql).toContain('tb_2_.NAME = $1)')
    expect(sql).toContain('and tb_1_.NAME = $2')
  })

  it('缺列的模型不会被注册，其查询不产生该过滤条件', async () => {
    const manager = await createGlobalFilterManager([BOOK, TENANT])
    manager.addGlobalFor('tenantId', (t) => (t as { eq(v: unknown): never }).eq(7))

    // BOOK 没有 tenantId，因此只有 TENANT 的 SQL 会带上条件
    const bookRun = capturingClient(manager)
    await selectBooks(bookRun.client)
    expect(normalize(bookRun.statements[0]!)).not.toContain('TENANT_ID')

    const tenantRun = capturingClient(manager)
    await tenantRun.client.createQuery(TENANT, (q, t) => q.select(t.id, t.tenantId)).fetchList()
    expect(normalize(tenantRun.statements[0]!)).toContain('where tb_1_.TENANT_ID = $1')
  })
})
