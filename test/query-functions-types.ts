import { model, prop } from '@ts-grm/core'
import type { DateExpression, NumExpression, StrExpression } from '@ts-grm/core'
import type { EnhancedSqlClient } from '../src/index'

const FUNCTION_TYPE_MODEL = model(
  'FunctionTypeModel',
  'id',
  class {
    id = prop.i32()
    name = prop.str(30)
    label = prop.str(30).nullable()
    at = prop.dt().nullable()
  },
)

/** Compile-only API checks; never executed by Vitest. */
export function checkFunctionTypes(client: EnhancedSqlClient): void {
  client.createQuery(FUNCTION_TYPE_MODEL, (q, t) => {
    const unchanged: StrExpression<string> = t.name.concat()
    // @ts-expect-error concat accepts strings/string expressions, not null literals.
    t.name.concat(null)
    // @ts-expect-error Both concat entry points reject numeric expressions.
    q.fn.concat(t.name, t.id)
    void unchanged

    const name: StrExpression<string> = q.fn.lower(t.name)
    const fallback: StrExpression<string> = q.fn.coalesce(t.label, 'fallback')
    const at: DateExpression<Date> = q.fn.asNonNull(t.at)
    const sum: NumExpression<number | null> = q.fn.sum(t.id)
    const text: NumExpression<string | null> = q.fn.sum(t.id, { as: 'string' })
    const times: NumExpression<number> = q.fn.times(t.id, 2)
    const nested: NumExpression<number> = q.fn.avg(t.id).coalesce(0).plus(1).coalesce(2)
    const nestedString: StrExpression<string> = q.fn
      .lower(t.name)
      .trim()
      .concat('!')
      .coalesce('none')
    const position: NumExpression<number> = q.fn.upper(t.name).position('X').plus(1).coalesce(0)
    const nullableLength: NumExpression<number | null> = q.fn.lower(t.label).length()
    const date: DateExpression<Date> = q.fn.min(t.at).coalesce(new Date()).plus(1, 'DAYS')
    const math: NumExpression<number> = q.fn.abs(t.id).sqrt().power(2).round(2).coalesce(0)
    const size: NumExpression<number | null> = q.fn.lower(t.label).charLength().abs()
    const distinct: NumExpression<number> = q.fn.countDistinct(t.name)
    q.fn.abs(text)
    // @ts-expect-error Numeric functions reject string expressions.
    q.fn.abs(t.name)
    // @ts-expect-error String lengths reject numeric expressions.
    q.fn.charLength(t.id)
    // @ts-expect-error POWER requires a numeric exponent.
    q.fn.abs(t.id).power('two')
    // @ts-expect-error Numeric results have no string length operation.
    q.fn.abs(t.id).charLength()
    // @ts-expect-error COUNT DISTINCT requires one expression, not a raw literal.
    q.fn.countDistinct('name')
    // @ts-expect-error String functions require string expressions.
    q.fn.lower(t.id)
    // @ts-expect-error Comparison preserves the expression's value type.
    q.fn.eq(t.name, 123)
    // @ts-expect-error COALESCE fallback must match the expression's value type.
    q.fn.coalesce(t.label, 123)
    // @ts-expect-error Expression fallbacks must also match the value type.
    q.fn.coalesce(t.label, t.id)
    // @ts-expect-error Numeric aggregate functions reject string-column expressions.
    q.fn.sum(t.name)
    // @ts-expect-error String chain fallbacks must remain strings.
    q.fn.lower(t.label).trim().coalesce(123)
    // @ts-expect-error A position result is numeric, so string transforms are unavailable.
    q.fn.upper(t.name).position('X').upper()
    // @ts-expect-error Function composition preserves the numeric input contract.
    q.fn.avg(t.id).coalesce('invalid')
    return q.where(t.id.gt(0)).select({
      name,
      fallback,
      at,
      sum,
      text,
      times,
      nested,
      nestedString,
      position,
      nullableLength,
      date,
      math,
      size,
      distinct,
    })
  })
  const query = client.createQuery(FUNCTION_TYPE_MODEL, (q, t) =>
    q
      .where(t.id.gt(0))
      .autoGroupBy()
      .select({
        id: t.id,
        name: q.fn.min(t.name).upper().concat('!').coalesce('empty'),
        average: q.fn.avg(t.id).coalesce(0).plus(1),
      }),
  )
  const rows: Promise<
    Array<{ readonly id: number; readonly name: string; readonly average: number }>
  > = query.fetchList()
  const scalar = client.createQuery(FUNCTION_TYPE_MODEL, (q, t) => q.where(t.id.gt(0)).select(t.id))
  const ids: Promise<number[]> = scalar.fetchList()
  const tuple = client.createQuery(FUNCTION_TYPE_MODEL, (q, t) =>
    q.where(t.id.gt(0)).select(t.id, t.name),
  )
  const tuples: Promise<readonly (readonly [number, string])[]> = tuple.fetchList()
  const subquery: NumExpression<number> = client.fn
    .subQuery(FUNCTION_TYPE_MODEL, (q, t) => q.where(t.id.gt(0)).select(t.id))
    .distinct()
    .asValue()
    .coalesce(0)
    .plus(1)
  void rows
  void ids
  void tuples
  void subquery
}
