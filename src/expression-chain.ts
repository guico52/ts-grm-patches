import { spi } from '@ts-grm/core'
import type {
  DateExpression,
  Expression,
  ExpressionLike,
  NumExpression,
  StrExpression,
  __MergeNumType,
} from '@ts-grm/core'

import { isExpression, QuerySemanticError } from './function-semantics'

type StringValue = string | null | undefined
type StringArgument =
  | string
  | StrExpression<string>
  | StrExpression<string | null>
  | StrExpression<string | undefined>
  | StrExpression<string | null | undefined>
type ExpressionValue<E extends ExpressionLike> =
  ReturnType<E['__type']> extends { readonly __t?: infer T } ? T : never
type Coalesced<T, A extends readonly unknown[]> = A extends readonly [...unknown[], infer Last]
  ? Last extends ExpressionLike
    ? NonNullable<T> | Extract<ExpressionValue<Last>, null | undefined>
    : NonNullable<T>
  : T
type Fallback<T> =
  | NonNullable<T>
  | Expression<NonNullable<T>>
  | Expression<T | null>
  | Expression<T | undefined>
  | Expression<T | null | undefined>
type NumericValue = number | string | null | undefined
type NumericOperation<T extends NumericValue> = <U extends NumericValue>(
  value: NonNullable<U> | NumExpression<U>,
) => ChainedNumExpression<__MergeNumType<T, U>>

export type ChainedNumExpression<T extends NumericValue> = {
  plus: NumericOperation<T>
  minus: NumericOperation<T>
  times: NumericOperation<T>
  div: NumericOperation<T>
  rem: NumericOperation<T>
  unaryMinus(): ChainedNumExpression<T>
  coalesce<const A extends readonly Fallback<T>[]>(
    ...values: A
  ): ChainedNumExpression<Coalesced<T, A>>
  asNonNull(): ChainedNumExpression<NonNullable<T>>
} & NumExpression<T>

export type ChainedDateExpression<T extends Date | null | undefined> = {
  plus(...args: Parameters<DateExpression<T>['plus']>): ChainedDateExpression<T>
  minus(...args: Parameters<DateExpression<T>['minus']>): ChainedDateExpression<T>
  diff(...args: Parameters<DateExpression<T>['diff']>): ChainedNumExpression<number>
  coalesce<const A extends readonly Fallback<T>[]>(
    ...values: A
  ): ChainedDateExpression<Coalesced<T, A>>
  asNonNull(): ChainedDateExpression<NonNullable<T>>
} & DateExpression<T>
type StringTransforms<T extends StringValue> = {
  [
    K in
      | 'lower'
      | 'upper'
      | 'trim'
      | 'ltrim'
      | 'reverse'
      | 'replace'
      | 'lpad'
      | 'rpad'
      | 'left'
      | 'right'
      | 'substring'
  ]: (...args: Parameters<StrExpression<T>[K]>) => ChainedStrExpression<T>
}

/** Corrected overloads precede the upstream string contract, keeping these values
 * assignable to native StrExpression while fixing its position() return type. */
export type ChainedStrExpression<T extends StringValue> = StringTransforms<T> & {
  concat(...values: readonly StringArgument[]): ChainedStrExpression<string | null>
  rtrim(): ChainedStrExpression<T>
  position(
    substring: string,
    start?: number | NumExpression<number>,
  ): ChainedNumExpression<number | null>
  length(): ChainedNumExpression<T extends string ? number : number | null>
  coalesce<const A extends readonly StringArgument[]>(
    ...values: A
  ): ChainedStrExpression<Coalesced<T, A>>
  asNonNull(): ChainedStrExpression<NonNullable<T>>
} & StrExpression<T>

export type ChainedExpression<T> = T extends ExpressionLike
  ? ReturnType<T['__type']> extends { strExpression: true }
    ? ChainedStrExpression<Extract<ExpressionValue<T>, StringValue>>
    : ReturnType<T['__type']> extends { numExpression: true }
      ? ChainedNumExpression<Extract<ExpressionValue<T>, NumericValue>>
      : ReturnType<T['__type']> extends { dateExpression: true }
        ? ChainedDateExpression<Extract<ExpressionValue<T>, Date | null | undefined>>
        : T
  : T

type Method = (...args: unknown[]) => unknown
const originals = new WeakMap<object, ReadonlyMap<string, Method>>()

/** Read the saved native method, including when another enhanced context uses
 * this expression. Functional and chained APIs never redispatch to each other. */
export function originalExpressionMethod(expression: object, name: string): Method {
  const method = originals.get(expression)?.get(name) ?? Reflect.get(expression, name)
  if (typeof method !== 'function')
    throw new TypeError(`fn.${name} requires an expression supporting ${name}()`)
  return method as Method
}

/** Decorate instances only. Their identity, prototype, visitor and SQL operands
 * are preserved, so the upstream query engine sees its original AST nodes. */
export function createExpressionEnhancer(
  names: readonly string[],
  invoke: (name: string, expression: object, args: readonly unknown[]) => unknown,
) {
  return function enhance<T>(value: T): ChainedExpression<T> {
    if (!isExpression(value) || originals.has(value)) return value as ChainedExpression<T>
    const marker = value.__type()
    const subquery = 'subQueryLike' in marker && marker.subQueryLike === true
    const paginationError = () =>
      new QuerySemanticError(
        'UNSUPPORTED_SUBQUERY_PAGINATION',
        'Native ts-grm 0.0.13 does not render subquery LIMIT/OFFSET',
      )
    if (subquery) {
      const options = Reflect.get(value, 'options') as Partial<spi.AtomQueryOptions> | undefined
      if ((options?.limit ?? -1) >= 0 || (options?.offset ?? 0) > 0) throw paginationError()
    }
    if (!Object.isExtensible(value))
      throw new TypeError('Cannot enhance a non-extensible expression')
    const saved = new Map<string, Method>()
    const descriptors: PropertyDescriptorMap = {}
    for (const name of names) {
      const method = Reflect.get(value, name)
      if (typeof method !== 'function') continue
      if (Object.getOwnPropertyDescriptor(value, name)?.configurable === false)
        throw new TypeError(`Cannot enhance read-only expression method ${name}`)
      saved.set(name, method as Method)
      descriptors[name] = { value: (...args: unknown[]) => invoke(name, value, args) }
    }
    // Keep enhancement after scalar-subquery cloning and asValue(). Pagination
    // is not rendered by the verified upstream version: reject, never drop it.
    // @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/sql/src/sql/fragment_gen_visitor.ts
    for (const name of ['asValue', 'distinct', 'limit', 'offset']) {
      const method = Reflect.get(value, name)
      if (typeof method !== 'function') continue
      if (Object.getOwnPropertyDescriptor(value, name)?.configurable === false)
        throw new TypeError(`Cannot enhance read-only expression method ${name}`)
      saved.set(name, method as Method)
      descriptors[name] = {
        value: (...args: unknown[]) => {
          if (subquery && (name === 'limit' || name === 'offset')) throw paginationError()
          return enhance(Reflect.apply(method, value, args))
        },
      }
    }
    if (value instanceof spi.AbstractStrExpr && !('concat' in value)) {
      descriptors.concat = {
        value: (...args: unknown[]) => invoke('concat', value, args),
      }
    }
    Object.defineProperties(value, descriptors)
    originals.set(value, saved)
    return value as ChainedExpression<T>
  }
}
