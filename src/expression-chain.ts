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
import { NUMERIC_FUNCTIONS, STRING_FUNCTIONS } from './portable-functions'
import type { PortableFunctions } from './portable-functions'

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
  [K in (typeof NUMERIC_FUNCTIONS)[number]]: PortableFunctions[K] extends (
    value: never,
    ...args: infer A
  ) => infer R
    ? (...args: A) => R
    : never
} & {
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
  charLength(): ChainedNumExpression<number | null>
  octetLength(): ChainedNumExpression<number | null>
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
type Invoke = (name: string, expression: object, args: readonly unknown[]) => unknown
interface MethodPlan {
  readonly originals: ReadonlyMap<string, Method>
  readonly descriptors: PropertyDescriptorMap
  readonly cacheable: boolean
}
interface ExpressionState {
  readonly plan: MethodPlan
  readonly invoke: Invoke
  readonly enhance: (value: unknown) => unknown
  readonly subquery: boolean
  methods?: Map<string, Method>
}
const states = new WeakMap<object, ExpressionState>()
const CLONE_METHODS = new Set(['asValue', 'distinct', 'limit', 'offset'])
// Predicates and orders already retain their expression operands. Only value
// transforms need redispatch to preserve further SQL-function chaining.
const VALUE_METHODS = new Set([
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
  'position',
  'coalesce',
  'unaryMinus',
  'plus',
  'minus',
  'times',
  'div',
  'rem',
  'diff',
  'asNonNull',
])

/** Read saved originals without evaluating an enhanced method getter. */
export function originalExpressionMethod(expression: object, name: string): Method {
  const method = states.get(expression)?.plan.originals.get(name) ?? Reflect.get(expression, name)
  if (typeof method !== 'function')
    throw new TypeError(`fn.${name} requires an expression supporting ${name}()`)
  return method as Method
}

function paginationError(): QuerySemanticError {
  return new QuerySemanticError(
    'UNSUPPORTED_SUBQUERY_PAGINATION',
    'Native ts-grm 0.0.13 does not render subquery LIMIT/OFFSET',
  )
}

/** Cache bound methods only when accessed. Unused methods allocate no closures.
 * Getters are shared across instances; cached functions retain detached-call
 * behavior and always dispatch through the expression's owning context.
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/get#smart_self-overwriting_lazy_getters
 */
function methodDescriptor(name: string): PropertyDescriptor {
  return {
    get(this: object): Method {
      const state = states.get(this)!
      const methods = (state.methods ??= new Map<string, Method>())
      let method = methods.get(name)
      if (method === undefined) {
        method = CLONE_METHODS.has(name)
          ? (...args: unknown[]) => {
              if (state.subquery && (name === 'limit' || name === 'offset')) throw paginationError()
              return state.enhance(Reflect.apply(state.plan.originals.get(name)!, this, args))
            }
          : (...args: unknown[]) => state.invoke(name, this, args)
        methods.set(name, method)
      }
      return method
    },
  }
}

/** Decorate instances only, preserving identity, prototype and visitor. Plans
 * cache immutable descriptor templates for each native prototype within this
 * context. Objects with own methods use an instance-specific plan instead.
 */
export function createExpressionEnhancer(names: readonly string[], invoke: Invoke) {
  names = names.filter((name) => VALUE_METHODS.has(name))
  const plans = new WeakMap<object, MethodPlan>()
  const relevant = new Set([
    ...names,
    ...CLONE_METHODS,
    'concat',
    ...NUMERIC_FUNCTIONS,
    ...STRING_FUNCTIONS,
  ])
  const createPlan = (value: object): MethodPlan => {
    const originals = new Map<string, Method>()
    const descriptors: PropertyDescriptorMap = Object.create(null) as PropertyDescriptorMap
    let cacheable = true
    for (const name of [...names, ...CLONE_METHODS]) {
      const method = Reflect.get(value, name)
      if (typeof method !== 'function') continue
      // An inherited accessor can return a method bound to this particular
      // instance. Never publish that method as a prototype-wide original.
      for (
        let owner: object | null = value;
        owner !== null;
        owner = Object.getPrototypeOf(owner) as object | null
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name)
        if (descriptor === undefined) continue
        if (descriptor.get !== undefined) cacheable = false
        break
      }
      if (Object.getOwnPropertyDescriptor(value, name)?.configurable === false)
        throw new TypeError(`Cannot enhance read-only expression method ${name}`)
      originals.set(name, method as Method)
      descriptors[name] = methodDescriptor(name)
    }
    if (value instanceof spi.AbstractStrExpr && !('concat' in value))
      descriptors.concat = methodDescriptor('concat')
    const additional =
      value instanceof spi.AbstractNumExpr
        ? NUMERIC_FUNCTIONS
        : value instanceof spi.AbstractStrExpr
          ? STRING_FUNCTIONS
          : []
    for (const name of additional) {
      if (Object.getOwnPropertyDescriptor(value, name)?.configurable === false)
        throw new TypeError(`Cannot enhance read-only expression method ${name}`)
      descriptors[name] = methodDescriptor(name)
    }
    return { originals, descriptors, cacheable }
  }
  function enhance<T>(value: T): ChainedExpression<T> {
    if (!isExpression(value) || states.has(value)) return value as ChainedExpression<T>
    const marker = value.__type()
    const subquery = 'subQueryLike' in marker && marker.subQueryLike === true
    if (subquery) {
      const options = Reflect.get(value, 'options') as Partial<spi.AtomQueryOptions> | undefined
      if ((options?.limit ?? -1) >= 0 || (options?.offset ?? 0) > 0) throw paginationError()
    }
    if (!Object.isExtensible(value))
      throw new TypeError('Cannot enhance a non-extensible expression')
    const prototype = Object.getPrototypeOf(value) as object | null
    const ownMethod = Object.getOwnPropertyNames(value).some((name) => relevant.has(name))
    let plan = prototype === null || ownMethod ? undefined : plans.get(prototype)
    if (plan === undefined) {
      plan = createPlan(value)
      if (prototype !== null && !ownMethod && plan.cacheable) plans.set(prototype, plan)
    }
    Object.defineProperties(value, plan.descriptors)
    states.set(value, { plan, invoke, enhance, subquery })
    return value as ChainedExpression<T>
  }
  return enhance
}
