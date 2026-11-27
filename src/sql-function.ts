import { dsl, spi } from '@ts-grm/core'
import type { Expression, ExpressionLike } from '@ts-grm/core'
import { isExpression, markFunction } from './function-semantics'
import type { FunctionKind } from './function-semantics'
import type { StrExpression, NumExpression, DateExpression } from '@ts-grm/core'

export type SqlArgument = ExpressionLike | string | number | boolean | Date | null
export type SqlResult = 'number' | 'string' | 'date' | 'boolean' | 'unknown'
export type SqlFunctionResult<T extends SqlResult> = T extends 'number'
  ? NumExpression<number | null>
  : T extends 'string'
    ? StrExpression<string | null>
    : T extends 'date'
      ? DateExpression<Date | null>
      : T extends 'boolean'
        ? Expression<boolean | null>
        : Expression<unknown>
type Parts = spi.NativeExprContract['parts']

class NativeNumber extends spi.AbstractNumExpr<number> {
  constructor(readonly parts: Parts) {
    super()
  }
  override get explicitDataType() {
    return spi.ExplicitDataType.FLOAT
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitNativeExpr(this)
  }
}
class NativeString extends spi.AbstractStrExpr {
  constructor(readonly parts: Parts) {
    super()
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitNativeExpr(this)
  }
}
class NativeDate extends spi.AbstractDtExpr {
  constructor(readonly parts: Parts) {
    super()
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitNativeExpr(this)
  }
}
class NativeValue extends spi.AbstractExpr<unknown> {
  constructor(readonly parts: Parts) {
    super()
  }
  override get explicitDataType() {
    // Preserve native booleans (Postgres) and NULL without the 0.0.13 BOOL decoder,
    // which turns NULL into true. Numeric predicates expose 'number' instead.
    return spi.ExplicitDataType.NONE
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitNativeExpr(this)
  }
}

export function sqlArgument(value: SqlArgument): ExpressionLike {
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    if (!isExpression(value)) throw new TypeError('Expected a SQL expression or scalar argument')
    return value
  }
  if (value === null) return markFunction(dsl.native.num`null`, { name: 'null', kind: 'scalar' })
  // collectNativeParts supports string literals at runtime, although 0.0.13's public
  // NativeValueType accidentally omits string. Keep this adaptation isolated.
  const expr = dsl.native.num`${value as never}` as unknown as spi.NativeExprContract
  return expr.parts[0] as ExpressionLike
}

export function sqlExpression<T extends SqlResult>(
  name: string,
  result: T,
  kind: FunctionKind,
  parts: Parts,
  dialect?: string,
): SqlFunctionResult<T> {
  const expr =
    result === 'number'
      ? new NativeNumber(parts)
      : result === 'string'
        ? new NativeString(parts)
        : result === 'date'
          ? new NativeDate(parts)
          : new NativeValue(parts)
  return markFunction(expr, { name, kind, dialect }) as unknown as SqlFunctionResult<T>
}

export function callParts(sqlName: string, args: readonly SqlArgument[]): Parts {
  const parts: Parts[number][] = [`${sqlName}(`]
  args.forEach((arg, index) => {
    if (index > 0) parts.push(', ')
    parts.push(sqlArgument(arg))
  })
  parts.push(')')
  return parts
}
