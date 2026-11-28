import pg from 'pg'
import { EntityManager, model, prop } from '@ts-grm/core'
import { PostgresDriver } from '@ts-grm/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyPatches } from '../../src/index'
import { newSqlClient } from '../../src/postgres'
import { serverTarget, skipServer, sortBy } from './support'

applyPatches()

const SALE = model(
  'ServerPgSale',
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

const TABLE = 'SERVER_PG_SALE'
const url = serverTarget('GRM_PG_URL')
skipServer('PostgreSQL', 'GRM_PG_URL')

/**
 * PostgreSQL 的真实服务端执行验证。
 *
 * 其余测试断言「生成的 SQL 长什么样」；这里断言**服务器真的接受这段 SQL，并且算出的
 * 值与 PostgreSQL 语义一致**。两者不能互相替代：函数名拼错、参数序号错位、Unicode
 * 或数值边界不符，只有连上真实数据库才会暴露。
 */
describe.skipIf(!url)('PostgreSQL server execution', () => {
  let pool: pg.Pool
  let db: ReturnType<typeof newSqlClient>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url! })
    await pool.query(`
      drop table if exists ${TABLE};
      create table ${TABLE} (
        ID integer primary key,
        CATEGORY varchar(30) not null,
        LABEL varchar(30),
        AMOUNT integer not null,
        TAX integer not null,
        BONUS integer
      );
      insert into ${TABLE} values
        (1, 'A', null, 1, 1, null),
        (2, 'a', null, 2, 1, null),
        (3, 'B', '中ab ', 5, 2, 7)
    `)
    db = newSqlClient(new PostgresDriver(pool), {
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
    // A single-column projection yields the column values themselves, not row objects.
    expect(hit).toEqual([1])
  })

  it('evaluates numeric functions with server semantics', async () => {
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
      // '中ab ' is 3 + 1 + 1 + 1 bytes in UTF-8.
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

  it('runs vendor functions PostgreSQL accepts', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) =>
        q.where(t.id.eq(1)).select({
          path: q.fn.postgres.jsonbExtractPathText(q.fn.native.num`'{"name":"x"}'::jsonb`, 'name'),
          contains: q.fn.postgres.jsonbContains(q.fn.native.num`'{"a":1}'::jsonb`, '{"a":1}'),
        }),
      )
      .fetchList()

    expect(row).toEqual({ path: 'x', contains: true })
  })
})
