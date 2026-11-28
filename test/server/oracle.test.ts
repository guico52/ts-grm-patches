import { EntityManager, model, prop } from '@ts-grm/core'
import { OracleDriver, OraclePool } from '@ts-grm/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyPatches } from '../../src/index'
import { newSqlClient } from '../../src/oracle'
import { serverTarget, skipServer, sortBy } from './support'

applyPatches()

const SALE = model(
  'ServerOraSale',
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

const TABLE = 'SERVER_ORA_SALE'
const url = serverTarget('GRM_ORACLE_URL')
skipServer('Oracle', 'GRM_ORACLE_URL')

/**
 * Oracle 的真实服务端执行验证。
 *
 * Oracle 有几处与其它方言根本不同、渲染字符串完全看不出来的行为：空串等于 NULL、
 * `length`/`lengthb` 的字节语义、以及绑定参数在 Oracle 下是真正的占位符（`:1`）。
 */
describe.skipIf(!url)('Oracle server execution', () => {
  let pool: OraclePool
  let db: ReturnType<typeof newSqlClient>

  beforeAll(async () => {
    const parsed = new URL(url!)
    pool = new OraclePool({
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      connectString: `${parsed.hostname}:${parsed.port || 1521}/${parsed.pathname.replace(/^\//, '')}`,
    })

    const raw = (await pool.getConnection()) as unknown as {
      execute: (sql: string, binds?: unknown, options?: unknown) => Promise<unknown>
      commit: () => Promise<void>
      close: () => Promise<void>
    }
    const run = async (sql: string) => {
      await raw.execute(sql)
    }
    try {
      await run(`drop table ${TABLE}`)
    } catch {
      // first run: table does not exist
    }
    await run(`create table ${TABLE} (
      ID number(10) primary key,
      CATEGORY varchar2(30) not null,
      LABEL varchar2(30),
      AMOUNT number(10) not null,
      TAX number(10) not null,
      BONUS number(10)
    )`)
    await run(`insert into ${TABLE} values (1, 'A', null, 1, 1, null)`)
    await run(`insert into ${TABLE} values (2, 'a', null, 2, 1, null)`)
    await run(`insert into ${TABLE} values (3, 'B', '中ab ', 5, 2, 7)`)
    await raw.commit()
    await raw.close()

    db = newSqlClient(new OracleDriver(pool), {
      entityManager: EntityManager.combine(SALE as never, SALE as never),
    })
  })

  afterAll(async () => {
    await pool?.close(0).catch(() => undefined)
  })

  it('binds values instead of splicing them into SQL', async () => {
    const injected = await db
      .createQuery(SALE, (q, t) => q.where(t.category.eq("A' or 1=1 --")).select(t.id))
      .fetchList()
    expect(injected).toEqual([])

    const hit = await db
      .createQuery(SALE, (q, t) => q.where(t.category.eq('A')).select(t.id))
      .fetchList()
    // Oracle's default binary comparison is case-sensitive, unlike MySQL/SQL Server.
    expect(hit).toEqual([1])
  })

  it('evaluates numeric functions with Oracle semantics', async () => {
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
          // Oracle pads by BYTE length under the default NLS_LENGTH_SEMANTICS=BYTE
          // (AL32UTF8), so a multibyte source yields one character less than the
          // requested width. This is documented under Known limitations rather than
          // silently normalized, because no portable rewrite preserves the contract.
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
      lpad: 'x中ab ',
      rpad: '中ab x',
      find: 3,
      absent: 0,
    })
  })

  it('reports the Oracle byte-length padding divergence for multibyte input', async () => {
    // Locked down explicitly so a future upstream/dialect change is visible: the same
    // call returns 6 characters on the other four dialects and 5 here.
    const [row] = await db
      .createQuery(SALE, (q) => {
        const text = q.fn.native.str`'中ab '`
        return q.where(q.fn.constant(1).eq(1)).select({
          chars: q.fn.charLength(text),
          padded: q.fn.lpad(text, 6, 'xy'),
          paddedChars: q.fn.charLength(q.fn.lpad(text, 6, 'xy')),
        })
      })
      .fetchList()

    expect(row).toEqual({ chars: 4, padded: 'x中ab ', paddedChars: 5 })
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

  it('runs vendor functions Oracle accepts', async () => {
    const [row] = await db
      .createQuery(SALE, (q, t) =>
        q.where(t.id.eq(1)).select({
          json: q.fn.oracle.jsonValue(q.fn.native.str`'{"name":"x"}'`, '$.name'),
          formatted: q.fn.oracle.toChar(q.fn.constant(42)),
          // String -> DATE relies on NLS_DATE_FORMAT, so convert explicitly; this is
          // the same trap users hit, and it is why the vendor namespace exposes toDate.
          months: q.fn.oracle.monthsBetween(
            q.fn.oracle.toDate(q.fn.native.str`'2020-01-01'`, 'YYYY-MM-DD'),
            q.fn.oracle.toDate(q.fn.native.str`'2020-04-01'`, 'YYYY-MM-DD'),
          ),
          lastDay: q.fn.oracle.lastDay(
            q.fn.oracle.toDate(q.fn.native.str`'2020-02-10'`, 'YYYY-MM-DD'),
          ),
        }),
      )
      .fetchList()

    expect(row!.json).toBe('x')
    expect(String(row!.formatted)).toContain('42')
    // months_between(d1, d2) is d1 - d2 in Oracle, so this direction is negative.
    expect(Number(row!.months)).toBeCloseTo(-3, 5)
    expect(String(row!.lastDay)).toContain('29')
  })
})
