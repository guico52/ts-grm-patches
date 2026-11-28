import { dsl, spi } from '@ts-grm/core'
import type {
  CmpExpression,
  DateExpression,
  EnumSetExpression,
  Expression,
  ExpressionLike,
  NumExpression,
  StrExpression,
  TimeUnit,
  __MergeNumType,
  __ExpressionItf,
  __CmpExpressionItf,
} from '@ts-grm/core'

import { getFunctionMetadata, markFunction } from './function-semantics'
import type { FunctionKind } from './function-semantics'
import { createDialectFunctions } from './dialect-functions'
import { createPortableFacade, deferredConcat } from './portable-expression'
import type { PortableFunctions, StringArgument } from './portable-functions'
import type { DialectFunctionsFor } from './dialect-functions'
import type { Dialect, DialectProfile } from './dialect-context'
import { assertSubqueryPagination } from './subquery-guard'
import { aggregate } from './aggregates'
import { installExpressionExtensions } from './expression-extensions'

type Callable = (...args: never[]) => unknown
type SpecialMethod =
  | '__type'
  | 'concat'
  | 'position'
  | 'length'
  | 'plus'
  | 'minus'
  | 'times'
  | 'div'
  | 'rem'
  | 'coalesce'
  | 'asNonNull'
type Lift<T> = {
  [K in keyof T as K extends SpecialMethod ? never : T[K] extends Callable ? K : never]: <
    E extends T,
  >(
    expression: E,
    ...args: Parameters<Extract<E[K], Callable>>
  ) => ReturnType<Extract<E[K], Callable>>
}
type Numeric =
  | NumExpression<number>
  | NumExpression<number | null>
  | NumExpression<string>
  | NumExpression<string | null>
type ValueOf<E extends ExpressionLike> =
  ReturnType<E['__type']> extends { readonly __t?: infer T } ? T : never
type ResultOf<E extends ExpressionLike, V> =
  ReturnType<E['__type']> extends { numExpression: true }
    ? NumExpression<Extract<V, number | string | null | undefined>>
    : ReturnType<E['__type']> extends { strExpression: true }
      ? StrExpression<Extract<V, string | null | undefined>>
      : ReturnType<E['__type']> extends { dateExpression: true }
        ? DateExpression<Extract<V, Date | null | undefined>>
        : ReturnType<E['__type']> extends { enumSetExpression: true }
          ? EnumSetExpression<Extract<V, string | null | undefined>>
          : ReturnType<E['__type']> extends { cmpExpression: true }
            ? CmpExpression<V>
            : Expression<V>
type FallbackValue<E extends ExpressionLike, A extends readonly unknown[]> = A extends readonly [
  ...unknown[],
  infer Last,
]
  ? Last extends ExpressionLike
    ? NonNullable<ValueOf<E>> | Extract<ValueOf<Last>, null | undefined>
    : NonNullable<ValueOf<E>>
  : ValueOf<E>
type FallbackExpression<E extends ExpressionLike> =
  | Expression<NonNullable<ValueOf<E>>>
  | Expression<ValueOf<E> | null>
  | Expression<ValueOf<E> | undefined>
  | Expression<ValueOf<E> | null | undefined>
interface Arithmetic {
  <T extends number | string | null | undefined, U extends number | string | null | undefined>(
    expression: NumExpression<T>,
    value: NonNullable<U> | NumExpression<U>,
  ): NumExpression<__MergeNumType<T, U>>
}
type DateArithmetic = <T extends Date | null | undefined>(
  expression: DateExpression<T>,
  value: number,
  unit: TimeUnit,
) => DateExpression<T>

interface NumericAggregate {
  <E extends Numeric>(expression: E): NumExpression<Extract<ValueOf<E>, number | string> | null>
  (expression: Numeric, options: { as: 'number' }): NumExpression<number | null>
  (expression: Numeric, options: { as: 'string' }): NumExpression<string | null>
}
type MinMax = {
  <T extends string | null | undefined>(expression: StrExpression<T>): StrExpression<string | null>
  <E extends Numeric>(expression: E): NumExpression<Extract<ValueOf<E>, number | string> | null>
  <T extends Date | null | undefined>(expression: DateExpression<T>): DateExpression<Date | null>
} & typeof dsl.min

export type QueryFunctions<D extends Dialect = Dialect> = DialectFunctionsFor<D> &
  PortableFunctions &
  Omit<
    typeof dsl,
    'count' | 'constant' | 'sum' | 'avg' | 'min' | 'max' | 'native' | 'subQuery' | 'baseQuery'
  > &
  Lift<__ExpressionItf<unknown>> &
  Lift<__CmpExpressionItf<unknown>> &
  Lift<StrExpression<string>> &
  Lift<StrExpression<string | null>> &
  Lift<NumExpression<number>> &
  Lift<NumExpression<number | null>> &
  Lift<NumExpression<string>> &
  Lift<NumExpression<string | null>> &
  Lift<DateExpression<Date>> &
  Lift<DateExpression<Date | null>> &
  Lift<EnumSetExpression<string>> &
  Lift<EnumSetExpression<string | null>> & {
    readonly sum: NumericAggregate
    readonly avg: NumericAggregate
    readonly min: MinMax
    readonly max: MinMax
    readonly count: (expression?: ExpressionLike) => NumExpression<number>
    readonly constant: (value: number) => NumExpression<number>
    readonly native: {
      str(...args: Parameters<typeof dsl.native.str>): StrExpression<string>
      date(...args: Parameters<typeof dsl.native.date>): DateExpression<Date>
      num: {
        (...args: Parameters<typeof dsl.native.num>): NumExpression<number>
        asString(...args: Parameters<typeof dsl.native.num.asString>): NumExpression<string>
      }
    }
    readonly plus: Arithmetic & DateArithmetic
    readonly minus: Arithmetic & DateArithmetic
    readonly times: Arithmetic
    readonly div: Arithmetic
    readonly rem: Arithmetic
    readonly coalesce: <
      E extends ExpressionLike,
      const A extends readonly (NonNullable<ValueOf<E>> | FallbackExpression<E>)[],
    >(
      expression: E,
      ...values: A
    ) => ResultOf<E, FallbackValue<E, A>>
    readonly asNonNull: <E extends ExpressionLike>(
      expression: E,
    ) => ResultOf<E, NonNullable<ValueOf<E>>>
    readonly subQuery: import('./query-enhancer').EnhancedSubQueryCreator<D>
    readonly baseQuery: import('./query-enhancer').EnhancedBaseQueryCreator<D>
    readonly concat: (
      ...values: [Exclude<StringArgument, null>, ...Exclude<StringArgument, null>[]]
    ) => StrExpression<string | null>
    readonly rtrim: <T extends string | null>(expression: StrExpression<T>) => StrExpression<T>
    readonly length: <T extends string | null | undefined>(
      expression: StrExpression<T>,
    ) => NumExpression<T extends string ? number : number | null>
    readonly position: <T extends string | null>(
      expression: StrExpression<T>,
      substring: string,
      start?: number | NumExpression<number>,
    ) => NumExpression<number | null>
    readonly scalar: <T extends ExpressionLike>(expression: T) => T
    readonly aggregate: <T extends ExpressionLike>(expression: T) => T
    readonly metadata: typeof getFunctionMetadata
  }

const EXPRESSION_METHODS = [
  'position',
  'asc',
  'desc',
  'eq',
  'ne',
  'in',
  'notIn',
  'inSubQuery',
  'notInSubQuery',
  'eqIf',
  'neIf',
  'inIf',
  'notInIf',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'ltIf',
  'lteIf',
  'gtIf',
  'gteIf',
  'betweenIf',
  'isNull',
  'isNotNull',
  'like',
  'ilike',
  'likeIf',
  'ilikeIf',
  'notLike',
  'notIlike',
  'notLikeIf',
  'notIlikeIf',
  'lower',
  'upper',
  'trim',
  'ltrim',
  'rtrim',
  'length',
  'reverse',
  'replace',
  'lpad',
  'rpad',
  'left',
  'right',
  'substring',
  'coalesce',
  'unaryMinus',
  'plus',
  'minus',
  'times',
  'div',
  'rem',
  'diff',
  'asNonNull',
  'containsAny',
  'notContainsAny',
  'containsAll',
  'notContainsAll',
] as const

/** Reuse the upstream function/AST implementations; add semantics at the boundary. */
export function createQueryFunctions<D extends Dialect>(
  subQuery: Callable,
  baseQuery: Callable,
  profile: DialectProfile<D>,
): QueryFunctions<D> {
  installExpressionExtensions()
  const dialect = profile.family
  const functions: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(dsl)) {
    if (typeof value === 'function') {
      functions[name] = (...args: unknown[]) =>
        markFunction(Reflect.apply(value, undefined, args), { name, kind: 'scalar' })
    }
  }
  for (const name of EXPRESSION_METHODS) {
    functions[name] = (expression: object, ...args: unknown[]) => {
      const method = Reflect.get(expression, name) as Callable
      if (name === 'coalesce' && args.length === 0)
        throw new TypeError('coalesce requires at least one fallback')
      return markFunction(Reflect.apply(method, expression, args), {
        name,
        kind: 'scalar',
      })
    }
  }
  for (const op of ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const) {
    functions[op.toLowerCase()] = (input?: unknown, options?: { as: 'number' | 'string' }) =>
      aggregate(op, input, options)
  }
  // Keep arbitrary native templates opaque; their SQL text is never parsed for SUM/OVER.
  const native =
    (name: string, create: Callable) =>
    (...args: unknown[]) =>
      markFunction(Reflect.apply(create, undefined, args), { name, kind: 'opaque', dialect })
  const nativeNumber = (...args: unknown[]) => {
    const result = Reflect.apply(dsl.native.num, undefined, args)
    Object.defineProperty(result, 'explicitDataType', { value: spi.ExplicitDataType.FLOAT })
    return markFunction(result, { name: 'native.num', kind: 'opaque', dialect })
  }
  functions.native = Object.freeze({
    num: Object.assign(nativeNumber, {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Native template tags are re-applied with an explicit receiver by callNative.
      asString: native('native.num.asString', dsl.native.num.asString),
    }),
    str: native('native.str', dsl.native.str),
    date: native('native.date', dsl.native.date),
  })
  functions.constant = (value: number) => {
    if (!Number.isFinite(value)) throw new TypeError('fn.constant requires a finite number')
    const result = dsl.constant(value)
    if (!Number.isInteger(value))
      Object.defineProperty(result, 'explicitDataType', { value: spi.ExplicitDataType.FLOAT })
    return markFunction(result, { name: 'constant', kind: 'scalar' })
  }
  functions.subQuery = subQuery
  functions.baseQuery = baseQuery
  functions.concat = (...values: unknown[]) => deferredConcat(values)

  for (const kind of ['scalar', 'aggregate'] as const satisfies readonly FunctionKind[]) {
    functions[kind] = <T extends ExpressionLike>(expression: T) => {
      assertSubqueryPagination(expression)
      return markFunction(
        expression,
        { ...getFunctionMetadata(expression), name: 'annotated', kind },
        true,
      )
    }
  }
  functions.metadata = getFunctionMetadata

  Object.assign(functions, createPortableFacade())

  Object.assign(functions, createDialectFunctions(dialect))
  return Object.freeze(functions) as unknown as QueryFunctions<D>
}
