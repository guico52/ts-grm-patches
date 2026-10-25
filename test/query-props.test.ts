import { EntityManager, dto, err, model, prop } from '@ts-grm/core'
import type { SqlClient } from '@ts-grm/core'
import { MySqlDriver, newSqlClient, PostgresDriver, SqliteDriver } from '@ts-grm/sql'
import { describe, expect, it, vi } from 'vitest'

import { applyPatches, bool, nullableBool } from '../src/index'
import { yieldingGetter } from '../src/query-props'

applyPatches()

const ARTICLE = model(
  'QueryArticle',
  'id',
  class {
    id = prop.i32()
    title = prop.str(50)
    body = prop.text().nullable()
    published = bool().default(false)
    pinned = nullableBool()
  },
)

// EntityManager.combine 至少需要两个模型；第二个模型不参与断言。
const TAG = model(
  'QueryTag',
  'id',
  class {
    id = prop.i32()
    name = prop.str(30)
  },
)

const ARTICLE_VIEW = dto.view(ARTICLE, (c) => [c.id, c.published, c.pinned, c.body])

interface QueryConfig {
  readonly text: string
  readonly values?: ReadonlyArray<unknown>
}

type Dialect = 'postgres' | 'mysql' | 'sqlite'

/** 各方言驱动所需的最小连接桩：只记录 SQL 与参数，返回空结果。 */
function driverOf(dialect: Dialect, statements: QueryConfig[]): unknown {
  switch (dialect) {
    case 'postgres': {
      const handle = (config: QueryConfig): unknown => {
        statements.push(config)
        return { rows: [], rowCount: 0, fields: [] }
      }
      const pool = {
        async connect() {
          return { query: handle, release() {} }
        },
        query: handle,
        async end() {},
      }
      return new PostgresDriver(pool as never)
    }
    case 'mysql': {
      const connection = {
        async query(config: { sql: string; values: ReadonlyArray<unknown> }) {
          statements.push({ text: config.sql, values: config.values })
          return [[]]
        },
        release() {},
      }
      return new MySqlDriver({ getConnection: async () => connection } as never)
    }
    case 'sqlite': {
      const database = {
        prepare(text: string) {
          return {
            raw() {},
            all(values: ReadonlyArray<unknown>) {
              statements.push({ text, values })
              return []
            },
          }
        },
        exec() {},
      }
      return new SqliteDriver(database as never)
    }
  }
}

/** 捕获真实 SQL 与参数，但不连接数据库（同 global-filter-sql.test.ts）。 */
function capturingClient(dialect: Dialect = 'postgres'): {
  client: SqlClient
  statements: QueryConfig[]
} {
  const statements: QueryConfig[] = []
  const client = newSqlClient(driverOf(dialect, statements) as never, {
    entityManager: EntityManager.combine(ARTICLE as never, TAG as never),
  })
  return { client, statements }
}

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

describe('BOOL / TEXT 列进入查询表达式', () => {
  it('布尔列可以 eq，参数按布尔值绑定', async () => {
    const { client, statements } = capturingClient()
    await client
      .createQuery(ARTICLE, (q, a) => q.where(a.published.eq(false)).select(a.id))
      .fetchList()

    expect(normalize(statements[0]!.text)).toBe(
      'select tb_1_.ID from QUERY_ARTICLE tb_1_ where tb_1_.PUBLISHED = $1',
    )
    expect(statements[0]!.values).toEqual([false])
  })

  it('可空布尔列支持 eq 与 isNull', async () => {
    const { client, statements } = capturingClient()
    await client
      .createQuery(ARTICLE, (q, a) => q.where(a.pinned.eq(true), a.body.isNull()).select(a.id))
      .fetchList()

    expect(normalize(statements[0]!.text)).toContain(
      'where tb_1_.PINNED = $1 and tb_1_.BODY is null',
    )
    expect(statements[0]!.values).toEqual([true])
  })

  it('文本列提供完整的字符串表达式：eq、like、lower、排序', async () => {
    const { client, statements } = capturingClient()
    await client
      .createQuery(ARTICLE, (q, a) =>
        q
          .where(a.body.eq('正文'), a.body.like('关键'), a.body.lower().eq('abc'))
          .orderBy(a.body.asc())
          .select(a.id, a.body),
      )
      .fetchList()

    expect(normalize(statements[0]!.text)).toBe(
      'select tb_1_.ID, tb_1_.BODY from QUERY_ARTICLE tb_1_ ' +
        'where tb_1_.BODY = $1 and tb_1_.BODY like $2 and lower(tb_1_.BODY) = $3 ' +
        'order by tb_1_.BODY asc',
    )
    expect(statements[0]!.values).toEqual(['正文', '%关键%', 'abc'])
  })

  it('取形（DTO 视图）不受影响', async () => {
    const { client, statements } = capturingClient()
    await client.createQuery(ARTICLE, (q, a) => q.select(a.fetch(ARTICLE_VIEW))).fetchList()

    expect(normalize(statements[0]!.text)).toBe(
      'select tb_1_.ID, tb_1_.PUBLISHED, tb_1_.PINNED, tb_1_.BODY from QUERY_ARTICLE tb_1_',
    )
  })

  it('同一张表上重复访问得到同一个表达式（与上游缓存行为一致）', async () => {
    const seen: unknown[] = []
    const { client } = capturingClient()
    await client
      .createQuery(ARTICLE, (q, a) => {
        seen.push(a.published, a.published)
        return q.select(a.id)
      })
      .fetchList()

    expect(seen[0]).toBe(seen[1])
  })
})

describe('其他方言', () => {
  it('MySQL：布尔与文本列按方言渲染', async () => {
    const { client, statements } = capturingClient('mysql')
    await client
      .createQuery(ARTICLE, (q, a) =>
        q.where(a.published.eq(true), a.body.like('关键')).select(a.id),
      )
      .fetchList()

    expect(normalize(statements[0]!.text)).toBe(
      'select tb_1_.ID from QUERY_ARTICLE tb_1_ where tb_1_.PUBLISHED = ? and tb_1_.BODY like ?',
    )
    expect(statements[0]!.values).toEqual([true, '%关键%'])
  })

  it('SQLite：布尔与文本列按方言渲染', async () => {
    const { client, statements } = capturingClient('sqlite')
    await client
      .createQuery(ARTICLE, (q, a) =>
        q.where(a.published.eq(true), a.body.like('关键')).select(a.id),
      )
      .fetchList()

    expect(normalize(statements[0]!.text)).toBe(
      'select tb_1_.ID from QUERY_ARTICLE tb_1_ where tb_1_.PUBLISHED = ? and tb_1_.BODY like ?',
    )
    expect(statements[0]!.values).toEqual([true, '%关键%'])
  })
})

describe('上游修复后自动让位', () => {
  it('上游 getter 成功时原样返回，不调用补丁', () => {
    const upstreamValue = { from: 'upstream' }
    const fallback = vi.fn(() => ({ from: 'patch' }))
    const getter = yieldingGetter(() => upstreamValue, fallback)

    expect(getter.call({})).toBe(upstreamValue)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('上游抛 ArgumentError 时才由补丁接管', () => {
    const patched = { from: 'patch' }
    const getter = yieldingGetter(
      () => {
        throw new err.ArgumentError('Cannot create table prop for "X.y" whose scalar type is BOOL')
      },
      () => patched,
    )

    expect(getter.call({})).toBe(patched)
  })

  it('上游因其他原因抛 ArgumentError 时照常抛出', () => {
    const failure = new err.ArgumentError('The property "X.y" is not entity property')
    const getter = yieldingGetter(
      () => {
        throw failure
      },
      () => 'patch',
    )

    expect(() => getter.call({})).toThrow(failure)
  })

  it('上游抛其他错误时照常抛出，不被吞掉', () => {
    const failure = new Error('unrelated failure')
    const getter = yieldingGetter(
      () => {
        throw failure
      },
      () => 'patch',
    )

    expect(() => getter.call({})).toThrow(failure)
  })
})
