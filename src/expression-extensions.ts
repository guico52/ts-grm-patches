import { dsl, spi } from '@ts-grm/core'
import type {
  Expression,
  ExpressionLike,
  NumExpression,
  StrExpression,
  DateExpression,
  EnumSetExpression,
  Predicate,
} from '@ts-grm/core'
import { aggregate } from './aggregates'
import { createPortableFacade, deferredConcat } from './portable-expression'
import { NUMERIC_FUNCTIONS } from './portable-functions'
import type { NumericArgument, StringArgument } from './portable-functions'
import { installStringRenderers } from './string-renderers'

type Nullish<T> = T | null | undefined
type ValueOf<E extends ExpressionLike> =
  ReturnType<E['__type']> extends { readonly __t?: infer T } ? T : never
type Fallback<T> =
  | NonNullable<T>
  | Expression<NonNullable<T>>
  | Expression<T | null>
  | Expression<T | undefined>
  | Expression<T | null | undefined>
type Coalesced<T, A extends readonly unknown[]> = A extends readonly [...unknown[], infer Last]
  ? Last extends ExpressionLike
    ? NonNullable<T> | Extract<ValueOf<Last>, null | undefined>
    : NonNullable<T>
  : T
declare module '@ts-grm/core' {
  interface __ExpressionItf<T> {
    count(): NumExpression<number>
    countDistinct(): NumExpression<number>
    min(): Expression<T | null>
    max(): Expression<T | null>
    and(this: Predicate, ...predicates: readonly (Predicate | null | undefined)[]): Predicate
    or(this: Predicate, ...predicates: readonly (Predicate | null | undefined)[]): Predicate
    not(this: Predicate): Predicate
  }
  interface __NumExpressionItf<T extends Nullish<string | number>> {
    coalesce<const A extends readonly Fallback<T>[]>(...values: A): NumExpression<Coalesced<T, A>>
    asNonNull(): NumExpression<NonNullable<T>>
    sum(): NumExpression<NonNullable<T> | null>
    avg(): NumExpression<NonNullable<T> | null>
    min(): NumExpression<NonNullable<T> | null>
    max(): NumExpression<NonNullable<T> | null>
    abs(): NumExpression<number | null>
    sign(): NumExpression<number | null>
    ceil(): NumExpression<number | null>
    floor(): NumExpression<number | null>
    round(digits?: number): NumExpression<number | null>
    trunc(): NumExpression<number | null>
    power(exponent: NumericArgument): NumExpression<number | null>
    sqrt(): NumExpression<number | null>
    exp(): NumExpression<number | null>
    ln(): NumExpression<number | null>
    log10(): NumExpression<number | null>
  }
  interface __StrExpressionItf<T extends Nullish<string>> {
    coalesce<const A extends readonly Fallback<T>[]>(...values: A): StrExpression<Coalesced<T, A>>
    asNonNull(): StrExpression<NonNullable<T>>
    min(): StrExpression<NonNullable<T> | null>
    max(): StrExpression<NonNullable<T> | null>
    rtrim(): StrExpression<T>
    concat(): StrExpression<T>
    concat(...values: readonly Exclude<StringArgument, null>[]): StrExpression<string | null>
    charLength(): NumExpression<number | null>
    octetLength(): NumExpression<number | null>
    length(): NumExpression<T extends string ? number : number | null>
    position(substr: string, start?: number | NumExpression<number>): NumExpression<number | null>
  }
  interface __DateExpressionItf<T extends Nullish<Date>> {
    coalesce<const A extends readonly Fallback<T>[]>(...values: A): DateExpression<Coalesced<T, A>>
    asNonNull(): DateExpression<NonNullable<T>>
    min(): DateExpression<Date | null>
    max(): DateExpression<Date | null>
  }
  interface __EnumSetExpressionItf<T extends Nullish<string>> {
    min(): EnumSetExpression<NonNullable<T> | null>
    max(): EnumSetExpression<NonNullable<T> | null>
  }
}

export function defineOnce(target: object, name: string, value: unknown) {
  if (!(name in target))
    Object.defineProperty(target, name, { value, configurable: true, writable: true })
}
let installed = false
export function installExpressionExtensions() {
  if (installed) return
  installed = true
  installStringRenderers()
  const portable = createPortableFacade()
  // PositionExpr is incorrectly a string node in 0.0.13. Preserve the node and
  // its visitor, but correct its inherited numeric operations/type decoder.
  const positionPrototype = Object.getPrototypeOf(dsl.native.str`''`.position('x')) as object
  if (Object.getPrototypeOf(positionPrototype) === spi.AbstractStrExpr.prototype)
    Object.setPrototypeOf(positionPrototype, spi.AbstractNumExpr.prototype)
  if (
    [spi.ExplicitDataType.STRING, spi.ExplicitDataType.NONE].includes(
      Reflect.get(dsl.native.str`''`.position('x'), 'explicitDataType'),
    )
  )
    Object.defineProperty(positionPrototype, 'explicitDataType', {
      configurable: true,
      get: () => spi.ExplicitDataType.INTEGER,
    })
  for (const [name, op] of [
    ['count', 'COUNT'],
    ['min', 'MIN'],
    ['max', 'MAX'],
    ['sum', 'SUM'],
    ['avg', 'AVG'],
  ] as const) {
    const prototype =
      name === 'sum' || name === 'avg' ? spi.AbstractNumExpr.prototype : spi.AbstractExpr.prototype
    defineOnce(prototype, name, function (this: ExpressionLike) {
      return aggregate(op, this)
    })
  }
  defineOnce(spi.AbstractExpr.prototype, 'countDistinct', function (this: ExpressionLike) {
    return portable.countDistinct(this)
  })
  for (const name of NUMERIC_FUNCTIONS) {
    defineOnce(
      spi.AbstractNumExpr.prototype,
      name,
      function (this: NumExpression<number>, ...args: unknown[]) {
        return Reflect.apply(portable[name], undefined, [this, ...args])
      },
    )
  }
  for (const name of ['charLength', 'octetLength'] as const) {
    defineOnce(spi.AbstractStrExpr.prototype, name, function (this: StrExpression<string>) {
      return portable[name](this)
    })
  }
  defineOnce(
    spi.AbstractStrExpr.prototype,
    'concat',
    function (this: StrExpression<string>, ...args: StringArgument[]) {
      return deferredConcat([this, ...args])
    },
  )
  for (const name of ['and', 'or'] as const) {
    defineOnce(
      spi.AbstractPred.prototype,
      name,
      function (this: Predicate, ...args: (Predicate | null | undefined)[]) {
        return dsl[name](this, ...args)
      },
    )
  }
  defineOnce(spi.AbstractPred.prototype, 'not', function (this: Predicate) {
    return dsl.not(this)
  })
  // @ts-grm 0.0.13–0.0.14 declares variadic coalesce publicly but its SPI implementation
  // takes one array. Bridge both call shapes once per prototype, not per value.
  // Version-specific repair: the peer range has no upper bound, so this bridge will not
  // step aside on its own. If upstream ships a native variadic implementation, review or
  // remove it and add that version to the test matrix; a native variadic implementation
  // must not receive [values].
  for (const prototype of [
    spi.AbstractExpr.prototype,
    spi.AbstractCmpExpr.prototype,
    spi.AbstractNumExpr.prototype,
    spi.AbstractStrExpr.prototype,
    spi.AbstractDtExpr.prototype,
    spi.AbstractEsExpr.prototype,
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'coalesce')
    if (!descriptor || typeof descriptor.value !== 'function') continue
    const original = descriptor.value as (...args: unknown[]) => unknown
    Object.defineProperty(prototype, 'coalesce', {
      ...descriptor,
      value(this: object, ...args: unknown[]) {
        const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
        if (!values.length) throw new TypeError('coalesce requires at least one fallback')
        return Reflect.apply(original, this, [values])
      },
    })
  }
}
