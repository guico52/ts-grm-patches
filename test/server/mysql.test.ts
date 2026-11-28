import mysql from 'mysql2/promise'
import { EntityManager, model, prop } from '@ts-grm/core'
import { MySqlDriver } from '@ts-grm/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyPatches } from '../../src/index'
import { newSqlClient } from '../../src/mysql'
import { serverTarget, skipServer, sortBy } from './support'

applyPatches()

const SALE = model(
  'ServerMySale',
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

const TABLE = 'SERVER_MY_SALE'
const url = serverTarget('GRM_MYSQL_URL')
skipServer('MySQL', 'GRM_MYSQL_URL')

/**
 * MySQL 的真实服务端执行验证。
 *
 * 重点在 MySQL 与 Postgres 语义不同、但渲染层断言看不出来的地方：没有
 * `FILTER`/`trunc`、`OCTET_LENGTH` 的别名行为、`GROUP BY` 与 `ONLY_FULL_GROUP_BY`
 * 的配合、以及 `?` 占位符下的参数绑定。
 */
describe.skipIf(!url)('MySQL server execution', () => {
  let pool: mysql.Pool
  let db: ReturnType<typeof newSqlClient>

  beforeAll(async () => {
    pool = mysql.createPool(url!)
    await pool.query(`drop table if exists ${TABLE}`)
    await pool.query(`create table ${TABLE} (
      ID int primary key,
      CATEGORY varchar(30) not null,
      LABEL varchar(30),
      AMOUNT int not null,
      TAX int not null,
      BONUS int
    )`)
    await pool.query(
      `insert into ${TABLE} values
        (1, 'A', null, 1, 1, null),
        (2, 'a', null, 2, 1, null),
        (3, 'B', '中ab ', 5, 2, 7)`,
    )
    db = newSqlClient(new MySqlDriver(pool), {
      entityManager: EntityManager.combine(SALE as never, SALE as never),
    })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('binds values instead of splicing them into SQL', async () => {
    const injected = await db
      .createQuery(SALE, (q, t) => q.where(t.category.eq("A') or 1=1 --")).select(t.id))
      .fetchList()
    expect(injected).toEqual([])

    const hit = await db
      .createQuery(SALE, (q, t) => q.where(t.category.eq('A')).select(t.id))
      .fetchList()
    // MySQL's default collation is case-insensitive, so 'A' matches both 'A' and 'a'.
    // This is a real dialect difference from Postgres that rendering tests cannot show.
    expect(sortBy(hit, (id) => id)).toEqual([1, 2])
  })

  it('evaluates numeric functions with MySQL semantics', async () => {
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

  it('evaluates string functions with Unicode semantics', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) => {
        const text = q.fn.native.str`'中ab '`
        const repeated = q.fn.native.str`'abab'`
        return q.where(t.id.eq(3)).select({
          upper: t.category.lower().upper(),
          trimmed: t.label.trim(),
          left: q.fn.left(text, 2),
          right: q.fn.right(text, 2),
          part: q.fn.substring(text, 2, 2),
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
      bytes: 6,
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

  it('groups by the full scalar key under ONLY_FULL_GROUP_BY', async () => {
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

  it('keeps aggregate results correct when nested inside arithmetic', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) =>
        q.select({
          total: q.fn.sum(t.amount).times(2).plus(1),
        }),
      )
      .fetchList()
    expect(row!.total).toBeCloseTo(17, 10)
  })

  it('runs vendor functions MySQL accepts', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) =>
        q.where(t.id.eq(1)).select({
          extracted: q.fn.mysql.jsonExtract(q.fn.native.str`'{"name":"x"}'`, '$.name'),
          unquoted: q.fn.mysql.jsonUnquote(q.fn.native.str`'"name"'`),
          position: q.fn.mysql.findInSet('b', 'a,b,c'),
          formatted: q.fn.mysql.dateFormat(q.fn.native.str`'2020-03-04 05:06:07'`, '%Y-%m'),
        }),
      )
      .fetchList()

    expect(row).toEqual({
      // mysql2 parses JSON columns, so JSON_EXTRACT comes back as a JS string.
      extracted: 'x',
      unquoted: 'name',
      position: 2,
      formatted: '2020-03',
    })
  })
})
