import { EntityManager, model, prop } from '@ts-grm/core'
import { SqlServer2012Driver, SqlServerPool } from '@ts-grm/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyPatches } from '../../src/index'
import { newSqlClient } from '../../src/sqlserver'
import { serverTarget, skipServer, sortBy } from './support'

applyPatches()

const SALE = model(
  'ServerMsSale',
  'id',
  class {
    id = prop.i32()
    category = prop.str(30)
    label = prop.str(30).nullable()
    amount = prop.i32()
    tax = prop.i32()
    bonus = prop.i32().nullable()
  },
)

const TABLE = 'SERVER_MS_SALE'
const url = serverTarget('GRM_MSSQL_URL')
skipServer('SQL Server', 'GRM_MSSQL_URL')

/**
 * SQL Server 的真实服务端执行验证。
 *
 * 这一方言的渲染层偏离最多（`len` 会裁掉尾随空格、`POWER` 整数行为、没有
 * `octet_length`/`trunc`），因此最有必要连真实实例核对，而不是只看生成的字符串。
 */
describe.skipIf(!url)('SQL Server server execution', () => {
  let pool: SqlServerPool
  let db: ReturnType<typeof newSqlClient>

  beforeAll(async () => {
    pool = new SqlServerPool(parseUrl(url!))
    // `getConnection()` hands back the underlying `mssql` connection pool, which this
    // test uses only to create its own fixture table.
    const underlying = (await pool.getConnection()) as unknown as {
      query: (sql: string) => Promise<unknown>
    }
    await underlying.query(`drop table if exists ${TABLE}`)
    await underlying.query(`create table ${TABLE} (
      ID int primary key,
      CATEGORY nvarchar(30) not null,
      LABEL nvarchar(30),
      AMOUNT int not null,
      TAX int not null,
      BONUS int
    )`)
    await underlying.query(`insert into ${TABLE} values
      (1, 'A', null, 1, 1, null),
      (2, 'a', null, 2, 1, null),
      (3, 'B', N'中ab ', 5, 2, 7)`)
    db = newSqlClient(new SqlServer2012Driver(pool), {
      entityManager: EntityManager.combine(SALE as never, SALE as never),
    })
  })

  afterAll(async () => {
    await pool?.close().catch(() => undefined)
  })

  it('binds values instead of splicing them into SQL', async () => {
    const injected = await db
      .createQuery(SALE, (q, t) => q.where(t.category.eq("A') or 1=1 --")).select(t.id))
      .fetchList()
    expect(injected).toEqual([])

    const hit = await db
      .createQuery(SALE, (q, t) => q.where(t.category.eq('A')).select(t.id))
      .fetchList()
    // SQL Server's default collation is case-insensitive as well.
    expect(sortBy(hit, (id) => id)).toEqual([1, 2])
  })

  it('evaluates numeric functions with SQL Server semantics', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) =>
        q.where(t.id.eq(1)).select({
          abs: q.fn.abs(-1.5),
          sign: q.fn.sign(-4),
          ceil: q.fn.ceil(-1.2),
          floor: q.fn.floor(-1.2),
          trunc: q.fn.trunc(-1.8),
          round: q.fn.round(1.25, 1),
          power: q.fn.power(2, -1),
          sqrt: q.fn.sqrt(9),
          log10: q.fn.log10(100),
          nested: q.fn.abs(-2).times(3).plus(1),
        }),
      )
      .fetchList()

    expect(row!.abs).toBeCloseTo(1.5, 10)
    expect(row!.sign).toBe(-1)
    expect(row!.ceil).toBe(-1)
    expect(row!.floor).toBe(-2)
    expect(row!.trunc).toBe(-1)
    expect(row!.round).toBeCloseTo(1.3, 10)
    expect(row!.power).toBeCloseTo(0.5, 10)
    expect(row!.sqrt).toBeCloseTo(3, 10)
    expect(row!.log10).toBeCloseTo(2, 10)
    expect(row!.nested).toBeCloseTo(7, 10)
  })

  it('trims trailing spaces before counting characters', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) => {
        const text = q.fn.native.str`N'中ab '`
        const repeated = q.fn.native.str`N'abab'`
        return q.where(t.id.eq(3)).select({
          upper: t.category.lower().upper(),
          trimmed: t.label.trim(),
          left: q.fn.left(text, 2),
          right: q.fn.right(text, 2),
          part: q.fn.substring(text, 2, 2),
          // LEN() ignores trailing spaces; the package compensates with a sentinel.
          chars: q.fn.charLength(text),
          bytes: q.fn.octetLength(text),
          lpad: q.fn.lpad(text, 6, 'xy'),
          rpad: q.fn.rpad(text, 6, 'xy'),
          find: q.fn.position(repeated, 'ab', 2),
          absent: q.fn.position(repeated, 'z', 2),
        })
      })
      .fetchList()

    expect(row).toEqual({
      upper: 'B',
      trimmed: '中ab',
      left: '中a',
      right: 'b ',
      part: 'ab',
      chars: 4,
      // DATALENGTH on nvarchar counts UTF-16 bytes: 3 * 2 + 1 * 2.
      bytes: 8,
      lpad: 'xy中ab ',
      rpad: '中ab xy',
      find: 3,
      absent: 0,
    })
  })

  it('keeps NULL semantics rather than coercing to zero', async () => {
    const [missing] = await db
      .createQuery(SALE, (q, t) =>
        q.where(t.id.eq(1)).select({
          chars: q.fn.charLength(t.label),
          coalesced: q.fn.coalesce(t.label, 'fallback'),
          nullableMath: q.fn.abs(t.bonus),
        }),
      )
      .fetchList()

    expect(missing).toEqual({ chars: null, coalesced: 'fallback', nullableMath: null })

    const [present] = await db
      .createQuery(SALE, (q, t) => q.where(t.id.eq(3)).select({ nullableMath: q.fn.abs(t.bonus) }))
      .fetchList()
    expect(present).toEqual({ nullableMath: 7 })
  })

  it('groups by the full scalar key and filters with HAVING', async () => {
    const rows = await db
      .createQuery(SALE, (q, t) =>
        q
          .autoGroupBy()
          .having(q.fn.sum(t.amount).gt(2))
          .select({
            key: t.category.lower(),
            total: q.fn.sum(t.amount),
            rows: q.fn.count(),
            distinctLabels: q.fn.countDistinct(t.label),
          }),
      )
      .fetchList()

    expect(sortBy(rows, (row) => row.key)).toEqual([
      { key: 'a', total: 3, rows: 2, distinctLabels: 0 },
      { key: 'b', total: 5, rows: 1, distinctLabels: 1 },
    ])
  })

  it('runs vendor functions SQL Server accepts', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) =>
        q.where(t.id.eq(1)).select({
          value: q.fn.sqlserver.jsonValue(q.fn.native.str`N'{"name":"x"}'`, '$.name'),
          isJson: q.fn.sqlserver.isJson(q.fn.native.str`N'{"name":"x"}'`),
          diff: q.fn.sqlserver.dateDiff(
            'day',
            q.fn.native.str`'2020-01-01'`,
            q.fn.native.str`'2020-01-11'`,
          ),
        }),
      )
      .fetchList()

    expect(row).toEqual({ value: 'x', isJson: 1, diff: 10 })
  })
})

/** `sqlserver://user:pass@host:port?database=db` -> mssql config. */
function parseUrl(raw: string) {
  const parsed = new URL(raw)
  return {
    server: parsed.hostname,
    port: Number(parsed.port || 1433),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'master',
    options: { trustServerCertificate: true, encrypt: true },
  }
}
