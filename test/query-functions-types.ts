import { model, prop } from '@ts-grm/core'
import type { DateExpression, NumExpression, StrExpression } from '@ts-grm/core'
import type { EnhancedSqlClient } from '../src/index'
import type {
  ChainedDateExpression,
  ChainedNumExpression,
  ChainedStrExpression,
} from '../src/index'

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
    const name: StrExpression<string> = q.fn.lower(t.name)
    const fallback: StrExpression<string> = q.fn.coalesce(t.label, 'fallback')
    const at: DateExpression<Date> = q.fn.asNonNull(t.at)
    const sum: NumExpression<number | null> = q.fn.sum(t.id)
    const text: NumExpression<string | null> = q.fn.sum(t.id, { as: 'string' })
    const times: NumExpression<number> = q.fn.times(t.id, 2)
    const nested: ChainedNumExpression<number> = q.fn.avg(t.id).coalesce(0).plus(1).coalesce(2)
    const nestedString: ChainedStrExpression<string> = q.fn
      .lower(t.name)
      .trim()
      .concat('!')
      .coalesce('none')
    const position: ChainedNumExpression<number> = q.fn
      .upper(t.name)
      .position('X')
      .plus(1)
      .coalesce(0)
    const nullableLength: ChainedNumExpression<number | null> = q.fn.lower(t.label).length()
    const date: ChainedDateExpression<Date> = q.fn.min(t.at).coalesce(new Date()).plus(1, 'DAYS')
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
    return q
      .select({
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
      })
      .where(t.id.gt(0))
  })
  const query = client.createQuery(FUNCTION_TYPE_MODEL, (q, t) =>
    q
      .select({
        id: t.id,
        name: q.fn.min(t.name).upper().concat('!').coalesce('empty'),
        average: q.fn.avg(t.id).coalesce(0).plus(1),
      })
      .where(t.id.gt(0))
      .autoGroupBy(),
  )
  const rows: Promise<
    Array<{ readonly id: number; readonly name: string; readonly average: number }>
  > = query.fetchList()
  const scalar = client.createQuery(FUNCTION_TYPE_MODEL, (q, t) => q.select(t.id).where(t.id.gt(0)))
  const ids: Promise<number[]> = scalar.fetchList()
  const tuple = client.createQuery(FUNCTION_TYPE_MODEL, (q, t) =>
    q.select(t.id, t.name).where(t.id.gt(0)),
  )
  const tuples: Promise<readonly (readonly [number, string])[]> = tuple.fetchList()
  const subquery: ChainedNumExpression<number> = client.fn
    .subQuery(FUNCTION_TYPE_MODEL, (q, t) => q.select(t.id).where(t.id.gt(0)))
    .distinct()
    .asValue()
    .coalesce(0)
    .plus(1)
  void rows
  void ids
  void tuples
  void subquery
}
