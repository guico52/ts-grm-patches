import { EntityManager, dsl, dto, model, prop } from '@ts-grm/core'
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
    store = prop.m2o(STORE).nullable()
  },
)

// 只有 TENANT_MODEL 有 tenantId，用来验证「缺列的模型不会被注册」
const TENANT_MODEL = model(
  'SqlTenant',
  'id',
  class {
    id = prop.i32()
    tenantId = prop.i32()
  },
)

const BOOK_VIEW = dto.view(BOOK, (c) => [c.id, c.name, c.store.with((s) => [s.id, s.name])])

interface QueryConfig {
  readonly text: string
}

interface CapturingOptions {
  readonly filterManager?: FilterManager
  /** 提供时主查询会返回这一行，从而触发关联批加载的第二条语句。 */
  readonly bookRow?: ReadonlyArray<unknown>
}

/**
 * 捕获真实 SQL，但不连接数据库。
 *
 * executor 由 `driver.transactionManager` 创建（`sql_client_impl.ts:346`），所以要在 pool
 * 这一层模拟：记录 `query()` 收到的 `{ text }`，并按需返回结果行。
 */
function capturingClient(options: CapturingOptions = {}): {
  client: SqlClient
  statements: string[]
} {
  const statements: string[] = []
  const empty = { rows: [], rowCount: 0, fields: [] }

  const handle = (config: QueryConfig): unknown => {
    statements.push(config.text)
    const isBookQuery = config.text.includes('SQL_BOOK') && !config.text.includes('SQL_STORE')
    if (isBookQuery && options.bookRow != null) {
      return { rows: [options.bookRow], rowCount: 1, fields: [] }
    }
    return empty
  }

  const pool = {
    async connect() {
      return { query: handle, release() {} }
    },
    query: handle,
    async end() {},
  }

  const client = newSqlClient(new PostgresDriver(pool as never), {
    entityManager: EntityManager.combine(
      EntityManager.combine(STORE as never, BOOK as never),
      TENANT_MODEL as never,
    ),
    ...(options.filterManager == null ? {} : { filterManager: options.filterManager }),
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

    const { client, statements } = capturingClient({ filterManager: manager })
    await selectBooks(client)

    expect(normalize(statements[0]!)).toContain('where tb_1_.NAME = $1')
  })

  it('子查询里也应用过滤器（主查询与子查询各一次）', async () => {
    const manager = await createGlobalFilterManager([BOOK])
    manager.addGlobalFor('name', (t) => (t as { eq(v: unknown): never }).eq('x'))

    const { client, statements } = capturingClient({ filterManager: manager })
    await selectBooksWithSubQuery(client)

    const sql = normalize(statements[0]!)
    expect(sql).toContain('in(select tb_2_.ID from')
    expect(sql).toContain('tb_2_.NAME = $1)')
    expect(sql).toContain('and tb_1_.NAME = $2')
  })

  it('缺列的模型不会被注册，其查询不产生该过滤条件', async () => {
    const manager = await createGlobalFilterManager([BOOK, TENANT_MODEL])
    manager.addGlobalFor('tenantId', (t) => (t as { eq(v: unknown): never }).eq(7))

    const bookRun = capturingClient({ filterManager: manager })
    await selectBooks(bookRun.client)
    expect(normalize(bookRun.statements[0]!)).not.toContain('TENANT_ID')

    const tenantRun = capturingClient({ filterManager: manager })
    await tenantRun.client
      .createQuery(TENANT_MODEL, (q, t) => q.select(t.id, t.tenantId))
      .fetchList()
    expect(normalize(tenantRun.statements[0]!)).toContain('where tb_1_.TENANT_ID = $1')
  })

  it('关联批加载的自动查询同样带上过滤器，主模型不受影响', async () => {
    const manager = await createGlobalFilterManager([STORE])
    manager.addGlobalFor('name', (t) => (t as { eq(v: unknown): never }).eq('x'))

    const { client, statements } = capturingClient({
      filterManager: manager,
      bookRow: [1, 'b1', 10], // 触发按 store_id 的关联批加载
    })
    await client.createQuery(BOOK, (q, b) => q.select(b.fetch(BOOK_VIEW))).fetchList()

    expect(statements).toHaveLength(2)
    // 主查询：BOOK 没有注册，条件不应出现
    expect(normalize(statements[0]!)).not.toContain('NAME = $')
    // 关联批加载：STORE 注册了，条件出现在第二条
    const association = normalize(statements[1]!)
    expect(association).toContain('from SQL_STORE')
    expect(association).toContain('and tb_1_.NAME = $2')
  })
})
