import { EntityManager, dsl, model, prop, spi } from '@ts-grm/core'
import type { NumExpression } from '@ts-grm/core'
import {
  newSqlClient,
  PostgresDriver,
  MySqlDriver,
  SqliteDriver,
  SqlServer2012Driver,
  Oracle12Drivier,
  FilterManager,
} from '@ts-grm/sql'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { enhanceClient, getFunctionMetadata, newSqlClient as deriveClient } from '../src/index'
import { newSqlClient as newSqliteClient } from '../src/sqlite'
import type { ChainedNumExpression, ChainedStrExpression, QueryConditions } from '../src/index'
import type { Dialect, DialectFunctions, EnhancedSqlClient, QueryFunctions } from '../src/index'
import type { DialectOptions } from '../src/index'
import { driverFamily } from '../src/dialect-context'

const SALES = model(
  'FunctionSale',
  'id',
  class {
    id = prop.i32()
    category = prop.str(30)
    label = prop.str(30).nullable()
    amount = prop.i32()
    tax = prop.i32()
    createdAt = prop.dt()
  },
)

interface Capture<D extends Dialect> {
  original: ReturnType<typeof newSqlClient>
  client: EnhancedSqlClient<D>
  statements: { text: string; values: unknown[] }[]
}
function capture(rows?: unknown[][]): Capture<'postgres'>
function capture(rows: unknown[][], dialect: 'postgres'): Capture<'postgres'>
function capture(rows: unknown[][], dialect: 'mysql'): Capture<'mysql'>
function capture(rows: unknown[][], dialect: 'sqlite'): Capture<'sqlite'>
function capture(rows: unknown[][], dialect: string, options?: DialectOptions): Capture<Dialect>
function capture(rows: unknown[][] = [], dialect = 'postgres', options?: DialectOptions): unknown {
  const statements: { text: string; values: unknown[] }[] = []
  const drivers = {
    postgres: PostgresDriver,
    mysql: MySqlDriver,
    sqlite: SqliteDriver,
    SqlServer2012: SqlServer2012Driver,
    Oracle12: Oracle12Drivier,
  }
  const Constructor = drivers[dialect as keyof typeof drivers]
  const driver = new Constructor({} as never)
  // Use real native driver/renderers while capturing at the execution boundary.
  Object.defineProperty(driver, 'transactionManager', {
    value: {
      executeReadonly: (fn: () => Promise<unknown>) => fn(),
      defaultExecutor: {
        async executeStatement(text: string, args: { value: unknown }[]) {
          statements.push({
            text: text.replace(/\s+/g, ' ').trim(),
            values: args.map((arg) => arg.value),
          })
          return rows
        },
      },
    },
  })
  const original = newSqlClient(driver, {
    entityManager: EntityManager.combine(SALES as never, SALES as never),
  })
  return {
    original,
    client: enhanceClient(original, driverFamily(driver.name), options),
    statements,
  }
}

describe('portable functions specialized by the bound dialect', () => {
  it.each([
    ['postgres', 'left(', 'right(', 'substr(', 'strpos('],
    ['mysql', 'left(', 'right(', 'substr(', 'locate('],
    ['sqlite', 'substr(', 'case when', 'substr(', 'instr('],
    ['SqlServer2012', 'left(', 'right(', 'substring(', 'charindex('],
    ['Oracle12', 'substr(', 'case when', 'substr(', 'instr('],
  ])(
    'specializes %s string functions and start-aware search',
    async (dialect, left, right, substring, position) => {
      const { client, statements } = capture([], dialect!)
      await client
        .createQuery(SALES, (q, t) =>
          q.select({
            left: q.fn.left(t.category, 2),
            right: q.fn.right(t.category, 2),
            substring: q.fn.substring(t.category, 2, 3),
            tail: q.fn.substring(t.category, 2),
            find: q.fn.position(t.category, 'x'),
            findAfter: q.fn.position(t.category, 'x', 2),
            nested: q.fn.lower(t.category).trim().lpad(4, 'xy').rpad(6).right(3),
          }),
        )
        .fetchList()
      for (const part of [left, right, substring, position])
        expect(statements[0]!.text).toContain(part)
      expect(statements[0]!.values).toContain('xy')
      if (dialect === 'SqlServer2012') {
        expect(statements[0]!.text).toContain('ltrim(rtrim(')
        expect(statements[0]!.text).toContain('replicate(cast(')
        expect(statements[0]!.text).toContain('as bigint), 2147483647)')
        expect(statements[0]!.text).not.toContain('substr(')
      }
      if (dialect === 'sqlite') expect(statements[0]!.text).toContain('replace(hex(zeroblob(')
    },
  )

  it('rejects unsupported reverse and invalid string ranges before rendering', () => {
    for (const dialect of ['sqlite', 'Oracle12']) {
      const { client } = capture([], dialect)
      expect(() => client.createQuery(SALES, (q, t) => q.select(q.fn.reverse(t.category)))).toThrow(
        'UNSUPPORTED_FUNCTION',
      )
    }
    const { client } = capture()
    client.createQuery(SALES, (q, t) => {
      expect(() => q.fn.left(t.category, -1)).toThrow('safe integer')
      expect(() => q.fn.substring(t.category, 0)).toThrow('safe integer')
      expect(() => q.fn.position(t.category, 'x', 0)).toThrow('safe integer')
      expect(() => q.fn.rpad(t.category, 0.5)).toThrow('safe integer')
      return q.select(t.id)
    })
  })
  it.each([
    ['postgres', 'ceil(', 'trunc(', 'ln(', 'log(', 'octet_length(', 'char_length('],
    ['mysql', 'ceil(', 'truncate(', 'ln(', 'log10(', 'octet_length(', 'char_length('],
    ['sqlite', 'ceil(', 'trunc(', 'ln(', 'log10(', 'octet_length(', 'length('],
    ['SqlServer2012', 'ceiling(', 'round(', 'log(', 'log10(', 'datalength(', 'len(cast('],
    ['Oracle12', 'ceil(', 'trunc(', 'ln(', 'log(10, ', 'lengthb(', 'length('],
  ])(
    'renders %s with its native SQL and bound data',
    async (dialect, ceil, trunc, ln, log10, bytes, chars) => {
      const { client, statements } = capture([], dialect!, {
        serverVersion: [3, 43],
        capabilities: { 'sqlite.mathFunctions': true },
      })
      await client
        .createQuery(SALES, (q, t) =>
          q.select({
            abs: q.fn.abs(t.amount),
            sign: q.fn.sign(t.amount),
            ceil: q.fn.ceil(t.amount),
            floor: q.fn.floor(t.amount),
            trunc: q.fn.trunc(t.amount),
            sqrt: q.fn.sqrt(t.amount),
            exp: q.fn.exp(t.amount),
            ln: q.fn.ln(t.amount),
            log10: q.fn.log10(t.amount),
            power: q.fn.power(t.amount, -1),
            round: q.fn.round(t.amount, 2),
            bytes: q.fn.octetLength(t.category),
            chars: q.fn.charLength(t.category),
            length: q.fn.lower(t.category).length(),
            bound: q.fn.charLength("中'); drop table FUNCTION_SALE; --"),
          }),
        )
        .fetchList()
      const statement = statements[0]!
      for (const sql of [ceil, trunc, ln, log10, bytes, chars])
        expect(statement.text).toContain(sql)
      expect(statement.values).toContain(-1)
      expect(statement.values).toContain(2)
      expect(statement.values).toContain("中'); drop table FUNCTION_SALE; --")
      expect(statement.text).not.toContain('drop table')
      if (dialect === 'postgres')
        expect(statement.text).toContain('round(cast(tb_1_.AMOUNT as numeric), ')
      if (dialect === 'SqlServer2012') {
        expect(statement.text).toContain('round(tb_1_.AMOUNT, 0, 1)')
        expect(statement.text).toContain('power(cast(tb_1_.AMOUNT as float), ')
        expect(statement.text).toContain("as nvarchar(max)) + N'#') - 1)")
      }
    },
  )

  it('preserves grouping dependencies and aggregate detection through new chains', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q.autoGroupBy().select({
          key: q.fn.lower(t.category).charLength().abs().round(),
          count: q.fn.countDistinct(t.label).plus(1),
          total: q.fn.sum(t.amount).abs().sqrt().round(),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toContain('count(distinct tb_1_.LABEL)')
    expect(statements[0]!.text).toMatch(
      /group by round\(cast\(abs\(char_length\(lower\(tb_1_\.CATEGORY\)\)\) as numeric\), 0\)$/,
    )
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().select(q.fn.countDistinct(q.fn.sum(t.amount)).abs()),
      ),
    ).toThrow('NESTED_AGGREGATE')
    const { client: other } = capture([], 'mysql')
    expect(() => other.createQuery(SALES, (q) => q.select(client.fn.abs(1)))).toThrow(
      'DIALECT_MISMATCH',
    )
  })

  it('requires explicit SQLite optional capabilities and respects overrides', () => {
    const { client } = capture([], 'sqlite')
    expect(() => client.fn.sqrt(4)).toThrow('sqlite.mathFunctions')
    expect(() => client.fn.constant(4).sqrt()).toThrow('sqlite.mathFunctions')
    expect(() => client.fn.octetLength('中')).toThrow('UNSUPPORTED_FUNCTION')
    const old = capture([], 'sqlite', { serverVersion: [3, 42, 9] }).client
    expect(() => old.fn.octetLength('中')).toThrow('UNSUPPORTED_FUNCTION')
    const supported = capture([], 'sqlite', { serverVersion: [3, 43] }).client
    expect(() => supported.fn.octetLength('中')).not.toThrow()
    const disabled = capture([], 'sqlite', {
      serverVersion: [3, 50],
      capabilities: { 'sqlite.octetLength': false },
    }).client
    expect(() => disabled.fn.octetLength('中')).toThrow('UNSUPPORTED_FUNCTION')
    const custom = capture([], 'sqlite', { capabilities: { 'sqlite.octetLength': true } }).client
    expect(() => custom.fn.octetLength('中')).not.toThrow()
  })

  it('validates the portable input contract before query execution', () => {
    const { client } = capture()
    expect(() => client.fn.abs(NaN)).toThrow('finite number')
    expect(() => client.fn.power(2, Infinity)).toThrow('finite number')
    for (const digits of [-1, 0.5, NaN, Infinity])
      expect(() => client.fn.round(1.25, digits)).toThrow('nonnegative safe integer')
    expect(() => client.fn.countDistinct(null as never)).toThrow('one expression')
    client.createQuery(SALES, (q, t) => {
      expect(() => q.fn.abs(t.category as never)).toThrow('numeric expression')
      expect(() => q.fn.charLength(t.amount as never)).toThrow('string expression')
      return q.select(t.id)
    })
  })
})

describe('q.fn native API extensions', () => {
  it('enhances only the selected client and is idempotent', () => {
    const { original, client } = capture()
    expect(client).toBe(original)
    expect(enhanceClient(original)).toBe(client)
    const unrelated = newSqlClient(new PostgresDriver({} as never), {})
    unrelated.createQuery(SALES, (q, t) => {
      expect('fn' in q).toBe(false)
      return q.select(t.id)
    })
  })

  it('exposes every installed DSL entry and tags scalar/aggregate functions', () => {
    const { client } = capture()
    client.createQuery(SALES, (q, t) => {
      for (const name of Object.keys(dsl)) expect(q.fn).toHaveProperty(name)
      for (const type of [
        spi.AbstractExpr,
        spi.AbstractCmpExpr,
        spi.AbstractStrExpr,
        spi.AbstractNumExpr,
        spi.AbstractDtExpr,
        spi.AbstractEsExpr,
      ]) {
        for (const [name, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(type.prototype),
        )) {
          if (!['constructor', '__type'].includes(name) && typeof descriptor.value === 'function')
            expect(q.fn).toHaveProperty(name)
        }
      }
      expect(getFunctionMetadata(q.fn.lower(t.category))).toEqual({ name: 'lower', kind: 'scalar' })
      for (const expr of [
        q.fn.sum(t.amount),
        q.fn.avg(t.amount),
        q.fn.min(t.amount),
        q.fn.max(t.amount),
        q.fn.count(),
      ]) {
        expect(getFunctionMetadata(expr)?.kind).toBe('aggregate')
      }
      return q.select(t.id)
    })
  })

  it('infers complete scalar keys, excludes aggregate inputs and deduplicates keys', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => {
        const category = q.fn.lower(t.category)
        return q
          .autoGroupBy()
          .select({ category, duplicate: q.fn.lower(t.category), total: q.fn.sum(t.amount) })
      })
      .fetchList()
    expect(statements[0]!.text).toMatch(/group by lower\(tb_1_\.CATEGORY\)$/)
    expect(statements[0]!.text).not.toMatch(/group by.*AMOUNT/)
  })

  it('finds aggregates inside arithmetic and infers only their outside dependencies', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q.autoGroupBy().select({
          adjusted: q.fn.sum(t.amount).plus(t.tax),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toMatch(/group by tb_1_\.TAX$/)
  })

  it('keeps nonaggregate rows and pure aggregate queries ungrouped', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => q.autoGroupBy().select(q.fn.lower(t.category)))
      .fetchList()
    await client
      .createQuery(SALES, (q, t) => q.autoGroupBy().select(q.fn.sum(t.amount)))
      .fetchList()
    expect(statements.every((s) => !s.text.includes('group by'))).toBe(true)
  })

  it('supports map, tuple, distinct, and original aggregate nodes', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => q.autoGroupBy().selectDistinct(t.category, dsl.sum(t.amount)))
      .fetchList()
    expect(statements[0]!.text).toMatch(/^select distinct/)
    expect(statements[0]!.text).toMatch(/group by tb_1_\.CATEGORY$/)
  })

  it('delays HAVING until automatic grouping and preserves bound business values', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => {
        const total = q.fn.sum(t.amount)
        return q
          .where(t.amount.gt(0))
          .having(total.gt(10))
          .autoGroupBy()
          .select({ category: t.category, total })
      })
      .fetchList()
    expect(statements[0]!.text).toContain('group by tb_1_.CATEGORY having sum(tb_1_.AMOUNT) > $2')
    expect(statements[0]!.values).toEqual([0, 10])
  })

  it('preserves types and fixes AVG integer decoding and MIN string operations', async () => {
    const { client } = capture([['2.75', '2.75', 'a', 'b', '2']])
    const result = await client
      .createQuery(SALES, (q, t) => {
        expectTypeOf(q.fn.avg(t.amount)).toEqualTypeOf<ChainedNumExpression<number | null>>()
        expectTypeOf(q.fn.sum(t.amount, { as: 'string' })).toEqualTypeOf<
          ChainedNumExpression<string | null>
        >()
        expectTypeOf(q.fn.lower(t.category)).toEqualTypeOf<ChainedStrExpression<string>>()
        expectTypeOf(q.fn.position(t.category, 'x')).toEqualTypeOf<
          ChainedNumExpression<number | null>
        >()
        expectTypeOf(q.fn.times(t.amount, 2)).toEqualTypeOf<ChainedNumExpression<number>>()
        expectTypeOf(q.fn.coalesce(t.label, 'fallback')).toEqualTypeOf<
          ChainedStrExpression<string>
        >()
        return q.select({
          avg: q.fn.avg(t.amount),
          text: q.fn.sum(t.amount, { as: 'string' }),
          min: q.fn.min(t.category).lower(),
          max: q.fn.max(t.category).upper(),
          position: q.fn.position(t.category, 'x'),
        })
      })
      .fetchList()
    expect(result).toEqual([{ avg: 2.75, text: '2.75', min: 'a', max: 'b', position: 2 }])
  })

  it('decodes enhanced native decimals and fractional constants without integer truncation', async () => {
    const { client } = capture([['2.75', '2.75']])
    const result = await client
      .createQuery(SALES, (q) => q.select(q.fn.native.num`2.75`, q.fn.constant(2.75)))
      .fetchList()
    expect(result).toEqual([[2.75, 2.75]])
  })

  it('supports scalar, numeric, date and nullable expression functions', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q.select({
          upper: q.fn.upper(t.category),
          trim: q.fn.trim(t.category),
          left: q.fn.left(t.category, 2),
          right: q.fn.right(t.category, 2),
          reverse: q.fn.reverse(t.category),
          lpad: q.fn.lpad(t.category, 4, 'x'),
          rpad: q.fn.rpad(t.category, 4, 'x'),
          replace: q.fn.replace(t.category, 'a', 'b'),
          part: q.fn.substring(t.category, 1, 2),
          length: q.fn.length(t.category),
          rtrim: q.fn.rtrim(t.category),
          ltrim: q.fn.ltrim(t.category),
          fallback: q.fn.coalesce(t.label, 'fallback'),
          math: q.fn.times(t.amount, 2),
          neg: q.fn.unaryMinus(t.amount),
          date: q.fn.plus(t.createdAt, 1, 'DAYS'),
          diff: q.fn.diff(t.createdAt, new Date('2020-01-01Z'), 'DAYS'),
          concat: q.fn.concat(t.category, ' suffix'),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toContain('coalesce(')
    expect(statements[0]!.text).toContain(' || ')
    expect(statements[0]!.values).toContain(' suffix')
  })

  it('enhances base queries and subqueries through q.fn without changing global dsl', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => {
        const sub = q.fn.subQuery(SALES, (sq, st) => {
          expect(sq.fn).toBe(q.fn)
          return sq.autoGroupBy().select(sq.fn.max(st.amount))
        })
        const base = q.fn.baseQuery(SALES, (bq, bt) =>
          bq.autoGroupBy().select({
            category: bt.category,
            total: bq.fn.sum(bt.amount),
          }),
        )
        expect(base).toBeDefined()
        return q.where(t.amount.eq(sub.asValue())).select(t.id)
      })
      .fetchList()
    expect(statements[0]!.text).toContain('select max(')
  })

  it('rejects inference that would silently change semantics', () => {
    const { client } = capture()
    expect(() =>
      client.createQuery(SALES, (q, t) => q.autoGroupBy().groupBy(t.category).select(t.id)),
    ).toThrow('GROUP_BY_CONFLICT')
    expect(() =>
      client.createQuery(SALES, (q, t) => q.groupBy(t.category).autoGroupBy().select(t.id)),
    ).toThrow('GROUP_BY_CONFLICT')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().orderBy(t.tax).select(t.category, q.fn.sum(t.amount)),
      ),
    ).toThrow('UNGROUPED_DEPENDENCY')
    expect(() =>
      client.createQuery(SALES, (q, t) => q.autoGroupBy().select(dsl.native.num`sum(${t.amount})`)),
    ).toThrow('OPAQUE_EXPRESSION')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().select(q.fn.concat(t.category, 'x'), q.fn.sum(t.amount)),
      ),
    ).toThrow('PARAMETERIZED_GROUP_KEY')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().select(q.fn.like(t.category, 'x')!, q.fn.sum(t.amount)),
      ),
    ).toThrow('PARAMETERIZED_GROUP_KEY')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().select(q.fn.in(t.amount, 1, 2), q.fn.sum(t.amount)),
      ),
    ).toThrow('PARAMETERIZED_GROUP_KEY')
    expect(() =>
      client.createQuery(SALES, (q, t) => q.autoGroupBy().select(q.fn.sum(q.fn.avg(t.amount)))),
    ).toThrow('NESTED_AGGREGATE')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().where(q.fn.sum(t.amount).gt(1)).select(t.category),
      ),
    ).toThrow('INVALID_STAGE')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.autoGroupBy().having(q.fn.sum(t.amount).gt(1)).select(q.fn.sum(t.amount)),
      ),
    ).toThrow('GLOBAL_HAVING_REQUIRES_STAGE')
  })

  it('accepts explicitly annotated native aggregates', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q.autoGroupBy().select({
          category: t.category,
          total: q.fn.aggregate(dsl.native.num`sum(${t.amount})`),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toMatch(/group by tb_1_\.CATEGORY$/)
  })

  it('rejects unsupported HAVING/ORDER BY rendering and ambiguous subquery inference', () => {
    const { client } = capture()
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q
          .autoGroupBy()
          .having(q.fn.sum(t.amount).gt(0))
          .orderBy(t.category)
          .select(t.category, q.fn.sum(t.amount)),
      ),
    ).toThrow('HAVING_ORDER_REQUIRES_STAGE')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q
          .autoGroupBy()
          .select(
            t.category,
            q.fn.subQuery(SALES, (sq, st) => sq.select(sq.fn.max(st.amount))).asValue(),
          ),
      ),
    ).toThrow('UNSUPPORTED_SUBQUERY')
  })

  it('keeps function contexts local across clients', () => {
    const pg = capture().client
    const my = capture([], 'mysql').client
    let expression: NumExpression<number | null> | undefined
    pg.createQuery(SALES, (q, t) => {
      expression = q.fn.postgres.tsRank(t.category, t.category)
      expect('mysql' in q.fn).toBe(false)
      return q.select(t.id)
    })
    expect(() =>
      my.createQuery(SALES, (q, t) =>
        q.autoGroupBy().select(t.category, q.fn.sum(t.amount), expression!),
      ),
    ).toThrow('DIALECT_MISMATCH')
    expect(() => my.createQuery(SALES, (q) => q.select(expression!))).toThrow('DIALECT_MISMATCH')
  })

  it('retains aggregate identity through scalar no-op helpers', () => {
    const { client } = capture([], 'sqlite')
    client.createQuery(SALES, (q, t) => {
      const aggregate = q.fn.sqlite.jsonGroupArray(t.category)
      q.fn.asNonNull(aggregate)
      expect(getFunctionMetadata(aggregate)?.kind).toBe('aggregate')
      return q.select(t.id)
    })
  })

  it.each([
    ['postgres', 'jsonb_extract_path_text'],
    ['mysql', 'timestampdiff(DAY'],
    ['sqlite', 'json_group_array'],
    ['SqlServer2012', 'datediff(day'],
    ['Oracle12', 'json_value'],
  ])('renders %s namespace templates and binds data', async (dialect, expected) => {
    const { client, statements } = capture([], dialect)
    // This parameterized test selects the active namespace by its runtime name;
    // static cross-dialect restrictions are covered separately by compile tests.
    const fn = client.fn as unknown as QueryFunctions & DialectFunctions
    await client
      .createQuery(SALES, (q, t) =>
        q.select({
          value:
            dialect === 'postgres'
              ? fn.postgres.jsonbExtractPathText(t.category, "x'quoted")
              : dialect === 'mysql'
                ? fn.mysql.timestampDiff('DAY', t.createdAt, new Date('2020-01-01Z'))
                : dialect === 'sqlite'
                  ? fn.sqlite.jsonGroupArray(t.category)
                  : dialect === 'SqlServer2012'
                    ? fn.sqlserver.dateDiff('day', t.createdAt, new Date('2020-01-01Z'))
                    : fn.oracle.jsonValue(t.category, '$."x\'quoted"'),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toContain(expected)
    if (dialect === 'Oracle12') expect(statements[0]!.text).toContain("x''quoted")
    else if (dialect !== 'sqlite') expect(statements[0]!.values.length).toBeGreaterThan(0)
  })

  it('supports additional SQL functions only with an explicit semantic contract', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q.autoGroupBy().select({
          category: t.category,
          total: q.fn.postgres.call(
            { name: 'my_schema.custom_sum', kind: 'aggregate', result: 'number' },
            t.amount,
          ),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toContain('my_schema.custom_sum(tb_1_.AMOUNT)')
    expect(statements[0]!.text).toMatch(/group by tb_1_\.CATEGORY$/)
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.select(
          q.fn.postgres.call(
            { name: 'x); drop table x; --', kind: 'scalar', result: 'number' },
            t.amount,
          ),
        ),
      ),
    ).toThrow('Invalid SQL function identifier')
  })

  it('marks native templates opaque until explicitly annotated', () => {
    const { client } = capture()
    client.createQuery(SALES, (q, t) => {
      const expr = q.fn.native.num`sum(${t.amount})`
      expect(getFunctionMetadata(expr)?.kind).toBe('opaque')
      q.fn.aggregate(expr)
      expect(getFunctionMetadata(expr)?.kind).toBe('aggregate')
      return q.select(t.id)
    })
  })

  it('uses explicit native projection stages for parameterized group keys', async () => {
    const { client, statements } = capture()
    const stage = client.fn.derivedModel(
      client.fn.baseQuery(SALES, (q, t) =>
        q.select({
          label: q.fn.coalesce(t.label, 'fallback'),
          amount: t.amount,
        }),
      ),
    )
    await client
      .createQuery(stage, (q, t) =>
        q.autoGroupBy().select({
          label: t.label,
          total: q.fn.sum(t.amount),
        }),
      )
      .fetchList()
    expect(statements[0]!.values).toEqual(['fallback'])
    expect(statements[0]!.text).toMatch(/group by tb_1_\.c1$/)
  })

  it('allows repeated WHERE clauses after map, tuple and distinct selections', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q
          .select({ id: t.id, name: t.category })
          .where(t.amount.gt(10))
          .where(undefined, null, t.tax.eq(2)),
      )
      .fetchList()
    await client
      .createQuery(SALES, (q, t) => q.select(t.id, t.category).where(t.id.gt(0)))
      .fetchList()
    await client
      .createQuery(SALES, (q, t) => q.selectDistinct(t.category).where(t.id.gt(0)))
      .fetchList()
    expect(statements[0]!.text).toContain('where tb_1_.AMOUNT > $1 and tb_1_.TAX = $2')
    expect(statements[0]!.values).toEqual([10, 2])
    expect(statements[1]!.text).toContain('where tb_1_.ID > $1')
    expect(statements[2]!.text).toMatch(/^select distinct/)
  })

  it('finalizes grouping using all conditions regardless of where select appears', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => {
        const total = q.fn.sum(t.amount)
        const projection = q.select({ category: t.category, total })
        q.where(t.amount.gt(0))
        return projection.autoGroupBy().having(total.gt(10))
      })
      .fetchList()
    expect(statements[0]!.text).toContain(
      'where tb_1_.AMOUNT > $1 group by tb_1_.CATEGORY having sum(tb_1_.AMOUNT) > $2',
    )
    expect(statements[0]!.values).toEqual([0, 10])
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.select(t.category, q.fn.sum(t.amount)).autoGroupBy().where(q.fn.sum(t.amount).gt(0)),
      ),
    ).toThrow('INVALID_STAGE')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.select(t.category, q.fn.sum(t.amount)).autoGroupBy().orderBy(t.tax),
      ),
    ).toThrow('UNGROUPED_DEPENDENCY')
  })

  it('accepts explicit grouping and deferred HAVING after select', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => {
        const total = q.fn.sum(t.amount)
        return q
          .select({ tax: t.tax, total })
          .having(total.gt(2))
          .where(t.amount.gt(0))
          .groupBy(t.tax)
      })
      .fetchList()
    expect(statements[0]!.text).toContain('group by tb_1_.TAX having sum(tb_1_.AMOUNT) > $2')
    expect(statements[0]!.values).toEqual([0, 2])
  })

  it('supports condition chains after base/subquery selections', async () => {
    const { client, statements } = capture()
    const base = client.fn.derivedModel(
      client.fn.baseQuery(SALES, (q, t) => q.select({ id: t.id }).where(t.amount.gt(2))),
    )
    await client.createQuery(base, (q, t) => q.select(t.id).where(t.id.gt(0))).fetchList()
    await client
      .createQuery(SALES, (q, t) =>
        q
          .select(t.id)
          .where(
            t.id.inSubQuery(
              q.fn.subQuery(SALES, (sq, st) => sq.select(st.id).where(st.amount.gt(5))),
            ),
          ),
      )
      .fetchList()
    expect(statements[0]!.values).toEqual([2, 0])
    expect(statements[1]!.text).toContain('in(select')
    expect(statements[1]!.values).toEqual([5])
    expect(() =>
      client.fn.subQuery(SALES, (q, t) => {
        q.autoGroupBy().where(q.fn.sum(t.amount).gt(0))
      }),
    ).toThrow('INVALID_STAGE')
  })

  it('closes query conditions on callback completion and when the callback throws', () => {
    const { client } = capture()
    let saved: QueryConditions<'postgres'> | undefined
    let predicate: ReturnType<NumExpression<number>['gt']> | undefined
    client.createQuery(SALES, (q, t) => {
      predicate = t.id.gt(0)
      const projection = q.select(t.id)
      saved = projection
      return projection
    })
    expect(() => saved!.where(predicate!)).toThrow('QUERY_FINALIZED')
    expect(() =>
      client.createQuery(SALES, (q, t) => {
        saved = q.select(t.id)
        throw new Error('abort callback')
      }),
    ).toThrow('abort callback')
    expect(() => saved!.where(predicate!)).toThrow('QUERY_FINALIZED')
    expect(() =>
      client.createQuery(SALES, (q, t) => {
        q.select(t.id)
        return q.select(t.category)
      }),
    ).toThrow('MULTIPLE_SELECTIONS')
  })

  it('recursively enhances chained numeric functions without changing aggregate grouping', async () => {
    const { client, statements } = capture([['a', '2.5']])
    const result = await client
      .createQuery(SALES, (q, t) => {
        const average = q.fn.avg(t.amount)
        const score = average.coalesce(0).plus(1).coalesce(99)
        expect(getFunctionMetadata(average)?.kind).toBe('aggregate')
        expect(getFunctionMetadata(score)?.kind).toBe('scalar')
        return q.select({ category: t.category, score }).where(t.amount.gt(0)).autoGroupBy()
      })
      .fetchList()
    expect(result).toEqual([{ category: 'a', score: 2.5 }])
    expect(statements[0]!.text).toContain('coalesce(coalesce(avg(tb_1_.AMOUNT), $1) + $2, $3)')
    expect(statements[0]!.text).toMatch(/group by tb_1_\.CATEGORY$/)
    expect(statements[0]!.values).toEqual([0, 1, 99, 0])
  })

  it('chains native string functions, concat and numeric position results', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q
          .select({
            label: q.fn.lower(t.category).trim().upper().concat('!').coalesce('none').rtrim(),
            position: q.fn.upper(t.category).position('X').plus(1).coalesce(0),
          })
          .where(t.id.gt(0)),
      )
      .fetchList()
    expect(statements[0]!.text).toContain('upper(trim(lower(tb_1_.CATEGORY)))')
    expect(statements[0]!.text).toContain(' || ')
    expect(statements[0]!.text).toContain('rtrim(coalesce(')
    expect(statements[0]!.values).toEqual(['!', 'none', 'X', 1, 0, 0])
  })

  it('shares the original-method dispatch between function and chain APIs', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) => {
        const sum = q.fn.sum(t.amount)
        const nonNull = q.fn.asNonNull(sum)
        expect(nonNull).toBe(sum)
        expect(getFunctionMetadata(nonNull)?.kind).toBe('aggregate')
        return q.select(q.fn.coalesce(nonNull.coalesce(0), 1).plus(2))
      })
      .fetchList()
    expect(statements[0]!.text).toContain('coalesce(coalesce(sum(tb_1_.AMOUNT), $1), $2) + $3')
  })

  it('enhances namespace, explicit-native and MIN/MAX string results', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q.select({
          json: q.fn.postgres
            .jsonbExtractPathText(t.category, 'path')
            .coalesce('none')
            .trim()
            .concat('!'),
          min: q.fn.min(t.category).coalesce('none').trim().upper(),
          native: q.fn.native.str`lower(${t.category})`.trim().concat('!'),
        }),
      )
      .fetchList()
    expect(statements[0]!.text).toContain('jsonb_extract_path_text(')
    expect(statements[0]!.text).toContain('upper(trim(coalesce(min(')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.select(q.fn.avg(q.fn.avg(t.amount).coalesce(0))).autoGroupBy(),
      ),
    ).toThrow('NESTED_AGGREGATE')
  })

  it('keeps enhancement through scalar subquery cloning and asValue()', async () => {
    const { client, statements } = capture()
    const expr = client.fn
      .subQuery(SALES, (sq, st) => sq.select(st.amount).where(st.id.gt(0)))
      .distinct()
      .asValue()
      .coalesce(0)
      .plus(1)
    await client.createQuery(SALES, (q, t) => q.select(expr).where(t.id.eq(1))).fetchList()
    expect(statements[0]!.text).toContain('coalesce(')
    expect(statements[0]!.text).toContain('select distinct')
    const subquery = client.fn.subQuery(SALES, (sq, st) => sq.select(st.amount))
    expect(() => subquery.limit(1)).toThrow('UNSUPPORTED_SUBQUERY_PAGINATION')
    expect(() => subquery.offset(1)).toThrow('UNSUPPORTED_SUBQUERY_PAGINATION')
    const raw = dsl.subQuery(SALES, (sq, st) => sq.select(st.amount)).limit(1)
    expect(() => client.fn.scalar(raw)).toThrow('UNSUPPORTED_SUBQUERY_PAGINATION')
  })

  it('keeps foreign-dialect provenance after arbitrary function chains', () => {
    const pg = capture().client
    const mysql = capture([], 'mysql').client
    const foreign = pg.fn.postgres.jsonbExtractPathText('value', 'path').coalesce('none').upper()
    expect(() => mysql.createQuery(SALES, (q) => q.select(foreign))).toThrow('DIALECT_MISMATCH')
  })

  it('chains date results through COALESCE, date arithmetic and numeric functions', async () => {
    const { client, statements } = capture()
    await client
      .createQuery(SALES, (q, t) =>
        q
          .select(
            q.fn
              .min(t.createdAt)
              .coalesce(new Date('2020-01-01Z'))
              .plus(1, 'DAYS')
              .diff(new Date('2020-01-01Z'), 'DAYS')
              .coalesce(0)
              .plus(1),
          )
          .autoGroupBy(),
      )
      .fetchList()
    expect(statements[0]!.text).toContain('coalesce(')
    expect(statements[0]!.text).toContain('min(tb_1_.CREATED_AT)')
    expect(statements[0]!.text).not.toContain('group by')
  })

  it('preserves source expressions and native prototypes when decorating new results', () => {
    const { client } = capture()
    const original = spi.AbstractNumExpr.prototype.coalesce
    client.createQuery(SALES, (q, t) => {
      const sourceLower = t.category.lower
      q.fn.lower(t.category).trim().concat('x')
      expect(t.category.lower).toBe(sourceLower)
      expect(spi.AbstractNumExpr.prototype.coalesce).toBe(original)
      expect(() => q.fn.avg(t.amount).coalesce()).toThrow('at least one fallback')
      return q.select(t.id)
    })
  })

  it('validates structural units and argument counts', () => {
    const { client } = capture([], 'mysql')
    expect(() =>
      client.createQuery(SALES, (q, t) =>
        q.select(q.fn.mysql.timestampDiff('day); --', t.createdAt, t.createdAt)),
      ),
    ).toThrow('invalid unit')
    expect(() => client.createQuery(SALES, (q) => q.select(q.fn.mysql.jsonExtract()))).toThrow(
      'invalid argument count',
    )
  })
})

const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
describe.skipIf(!sqlite)('real SQLite execution through native SqliteDriver', () => {
  it('groups correctly, including NULL inputs, mixed expressions and empty aggregates', async () => {
    const database = new sqlite!.DatabaseSync(':memory:')
    // Adapt node:sqlite's statement interface to the better-sqlite3 interface expected by upstream.
    const adapter = {
      exec: (sql: string) => database.exec(sql),
      prepare(sql: string) {
        const statement = database.prepare(sql)
        return {
          raw() {
            statement.setReturnArrays(true)
          },
          all(values: unknown[]) {
            return statement.all(...(values as never[]))
          },
        }
      },
    }
    try {
      database.exec(`create table FUNCTION_SALE (ID integer primary key, CATEGORY text, LABEL text, AMOUNT integer, TAX integer, CREATED_AT text);
        insert into FUNCTION_SALE values (1, 'A', null, 1, 1, '2020-01-01'), (2, 'a', null, 2, 1, '2020-01-01'), (3, 'B', null, 5, 2, '2020-01-01')`)
      const client = newSqliteClient(new SqliteDriver(adapter as never), {
        entityManager: EntityManager.combine(SALES as never, SALES as never),
      })
      const mathEnabled =
        database
          .prepare("select sqlite_compileoption_used('ENABLE_MATH_FUNCTIONS') as enabled")
          .get()!.enabled === 1
      const functionsClient = deriveClient(
        client,
        {},
        {
          serverVersion: [3, 43],
          capabilities: { 'sqlite.mathFunctions': mathEnabled },
        },
      )
      const values = await functionsClient
        .createQuery(SALES, (q, t) =>
          q
            .select({
              abs: q.fn.abs(-1.5).round(1),
              sign: q.fn.sign(-4),
              round: q.fn.round(1.25, 1),
              chars: q.fn.charLength('中文  '),
              bytes: q.fn.octetLength('中文  '),
              empty: q.fn.charLength(''),
              null: q.fn.charLength(t.label),
              nullableMath: q.fn.abs(null).round(),
            })
            .where(t.id.eq(1)),
        )
        .fetchList()
      expect(values).toEqual([
        {
          abs: 1.5,
          sign: -1,
          round: 1.3,
          chars: 4,
          bytes: 8,
          empty: 0,
          null: null,
          nullableMath: null,
        },
      ])
      const strings = await client
        .createQuery(SALES, (q, t) => {
          const text = q.fn.native.str`'中ab '`
          const repeated = q.fn.native.str`'abab'`
          return q
            .select({
              left: q.fn.left(text, 2),
              right: q.fn.right(text, 2),
              rightZero: q.fn.right(text, 0),
              part: q.fn.substring(text, 2, 2),
              tail: q.fn.substring(text, 2),
              lpad: q.fn.lpad(text, 6, 'xy'),
              rpad: q.fn.rpad(text, 6, 'xy'),
              shortened: q.fn.lpad(text, 2, 'xy'),
              noFill: q.fn.rpad(text, 6, ''),
              find: q.fn.position(repeated, 'ab', 2),
              absent: q.fn.position(repeated, 'z', 2),
              nullPad: q.fn.lpad(t.label, 4),
              nullRight: q.fn.right(t.label, 0),
              nullFind: q.fn.position(t.label, 'a', 2),
            })
            .where(t.id.eq(1))
        })
        .fetchList()
      expect(strings).toEqual([
        {
          left: '中a',
          right: 'b ',
          rightZero: '',
          part: 'ab',
          tail: 'ab ',
          lpad: 'xy中ab ',
          rpad: '中ab xy',
          shortened: '中a',
          noFill: '中ab ',
          find: 3,
          absent: 0,
          nullPad: null,
          nullRight: null,
          nullFind: null,
        },
      ])
      const distinct = await functionsClient
        .createQuery(SALES, (q, t) =>
          q
            .select({
              key: q.fn.lower(t.category).charLength().abs().round(),
              count: q.fn.countDistinct(q.fn.lower(t.category)),
              nullCount: q.fn.countDistinct(t.label),
            })
            .autoGroupBy(),
        )
        .fetchList()
      expect(distinct).toEqual([{ key: 1, count: 2, nullCount: 0 }])
      if (mathEnabled) {
        const math = await functionsClient
          .createQuery(SALES, (q, t) =>
            q
              .select({
                ceil: q.fn.ceil(-1.2),
                floor: q.fn.floor(-1.2),
                trunc: q.fn.trunc(-1.8),
                power: q.fn.power(2, -1),
                sqrt: q.fn.constant(9).sqrt().round(),
                ln: q.fn.ln(q.fn.exp(1)).round(),
                log10: q.fn.log10(100).round(),
                aggregate: q.fn.sum(t.amount).sqrt().round(2),
              })
              .autoGroupBy(),
          )
          .fetchList()
        expect(math).toEqual([
          {
            ceil: -1,
            floor: -2,
            trunc: -1,
            power: 0.5,
            sqrt: 3,
            ln: 1,
            log10: 2,
            aggregate: 2.83,
          },
        ])
      }
      const result = await client
        .createQuery(SALES, (q, t) => {
          const category = q.fn.lower(t.category)
          return q
            .autoGroupBy()
            .orderBy(category)
            .select({
              category,
              total: q.fn.sum(t.amount),
              avg: q.fn.avg(t.amount),
            })
        })
        .fetchList()
      expect(result).toEqual([
        { category: 'a', total: 3, avg: 1.5 },
        { category: 'b', total: 5, avg: 5 },
      ])
      const mixed = await client
        .createQuery(SALES, (q, t) =>
          q
            .autoGroupBy()
            .orderBy(t.tax)
            .select({ tax: t.tax, value: q.fn.sum(t.amount).plus(t.tax) }),
        )
        .fetchList()
      expect(mixed).toEqual([
        { tax: 1, value: 4 },
        { tax: 2, value: 7 },
      ])
      const empty = await client
        .createQuery(SALES, (q, t) =>
          q
            .autoGroupBy()
            .where(t.id.lt(0))
            .select({
              avg: q.fn.avg(t.amount),
              count: q.fn.count(),
            }),
        )
        .fetchList()
      expect(empty).toEqual([{ avg: null, count: 0 }])
      const json = await client
        .createQuery(SALES, (q, t) =>
          q
            .autoGroupBy()
            .orderBy(t.tax)
            .select({
              tax: t.tax,
              categories: q.fn.sqlite.jsonGroupArray(t.category),
            }),
        )
        .fetchList()
      expect(json).toEqual([
        { tax: 1, categories: '["A","a"]' },
        { tax: 2, categories: '["B"]' },
      ])
      const composed = await client
        .createQuery(SALES, (q, t) => {
          const category = q.fn.lower(t.category).trim().upper()
          return q
            .select({ category, score: q.fn.avg(t.amount).coalesce(0).plus(1).coalesce(99) })
            .where(t.amount.gt(1))
            .autoGroupBy()
            .orderBy(category)
        })
        .fetchList()
      expect(composed).toEqual([
        { category: 'A', score: 3 },
        { category: 'B', score: 6 },
      ])
      const emptyComposed = await client
        .createQuery(SALES, (q, t) =>
          q
            .select({
              score: q.fn.avg(t.amount).coalesce(7).plus(1),
            })
            .where(t.id.lt(0))
            .autoGroupBy(),
        )
        .fetchList()
      expect(emptyComposed).toEqual([{ score: 8 }])
      const nullableString = await client
        .createQuery(SALES, (q, t) =>
          q.select(q.fn.min(t.label).coalesce('empty').concat('!').upper()).autoGroupBy(),
        )
        .fetchList()
      expect(nullableString).toEqual(['EMPTY!'])
      const position = await client
        .createQuery(SALES, (q, t) =>
          q
            .select({
              id: t.id,
              position: q.fn.upper(t.category).position('A').plus(1).coalesce(0),
            })
            .where(t.id.eq(1)),
        )
        .fetchList()
      expect(position).toEqual([{ id: 1, position: 2 }])
      const subqueryRows = await client
        .createQuery(SALES, (q, t) =>
          q
            .select(t.id)
            .where(
              t.id.inSubQuery(
                q.fn.subQuery(SALES, (sq, st) => sq.select(st.id).where(st.amount.gt(1))),
              ),
            )
            .orderBy(t.id),
        )
        .fetchList()
      expect(subqueryRows).toEqual([2, 3])
      const scalarSubquery = client.fn
        .subQuery(SALES, (sq, st) => sq.select(sq.fn.max(st.amount)).where(st.amount.gt(1)))
        .asValue()
        .coalesce(0)
        .plus(1)
      const subqueryNested = await client
        .createQuery(SALES, (q, t) => q.select(scalarSubquery).where(t.id.eq(1)))
        .fetchList()
      expect(subqueryNested).toEqual([6])
      const manager = new FilterManager()
      manager.add(SALES, (t) => t.tax.gt(1))
      const filtered = deriveClient(client, { filterManager: manager, defaultBatchSize: 4 })
      expect(filtered.dialect).toBe('sqlite')
      const filteredRows = await filtered
        .createQuery(SALES, (q, t) =>
          q
            .select({
              tax: t.tax,
              names: q.fn.sqlite.jsonGroupArray(t.category),
              total: q.fn.sum(t.amount).coalesce(0),
            })
            .where(t.amount.gt(0))
            .autoGroupBy(),
        )
        .fetchList()
      expect(filteredRows).toEqual([{ tax: 2, names: '["B"]', total: 5 }])
      expect(
        await client.createQuery(SALES, (q, t) => q.select(t.id).orderBy(t.id)).fetchList(),
      ).toEqual([1, 2, 3])
    } finally {
      database.close()
    }
  })
})
