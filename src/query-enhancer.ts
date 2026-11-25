import { dsl } from '@ts-grm/core'
import type {
  AnyAssociationModel,
  AnyModel,
  AtLeastOne,
  AtomBaseQuery,
  AtomExpressionSubQuery,
  AtomRootQuery,
  AtomTupleSubQuery,
  BaseModel,
  BaseQueryProjection,
  BaseQuerySelectMapArgs,
  MutableBaseQuery,
  MutableRootQuery,
  MutableSubQuery,
  ExpressionLike,
  ExpressionOrder,
  Predicate,
  RootQueryProjection,
  RootQuerySelectArrArgs,
  RootQuerySelectMapArgs,
  SelectionLike,
  SqlClient,
  SubQueryProjection,
  SubQuerySelectArrArgs,
  Table,
} from '@ts-grm/core'

import {
  inferGroupBy,
  isExpression,
  QuerySemanticError,
  validateFunctionDialects,
} from './function-semantics'
import { createQueryFunctions } from './query-functions'
import type { QueryFunctions } from './query-functions'
import type { ChainedExpression, ChainedNumExpression } from './expression-chain'
import { createDialectProfile, resolveDriverFamily } from './dialect-context'
import type { Dialect, DialectOptions, DialectProfile } from './dialect-context'
import type { newSqlClient as nativeNewSqlClient } from '@ts-grm/sql'

type Model = AnyModel | BaseModel<BaseQuerySelectMapArgs> | AnyAssociationModel
type Tables<M extends readonly Model[]> = { [K in keyof M]: Table<M[K]> }
type SubTables<M extends readonly Model[]> = { [K in keyof M]: Table<M[K], 'ARBITRARY'> }

export interface QueryExtensions<D extends Dialect = Dialect> {
  readonly fn: QueryFunctions<D>
  /** Infer keys when the query callback completes. */
  autoGroupBy(): this
}
export interface QueryConditions<D extends Dialect = Dialect> extends QueryExtensions<D> {
  where(...predicates: readonly (Predicate | null | undefined)[]): this
  having(...predicates: readonly (Predicate | null | undefined)[]): this
  orderBy(...orders: readonly (ExpressionLike | ExpressionOrder)[]): this
  groupBy(...expressions: readonly ExpressionLike[]): this
}
/** The native projection with conditions bound to its owning query callback. */
export type SelectedQuery<P, D extends Dialect = Dialect> = P & QueryConditions<D>
type MutableWithoutSelect<Q, D extends Dialect> = Omit<
  Q,
  'select' | 'selectDistinct' | keyof QueryConditions
> &
  QueryConditions<D>
interface RootSelect<D extends Dialect> {
  <T extends SelectionLike>(selection: T): SelectedQuery<RootQueryProjection<T, 'ONE'>, D>
  <const T extends RootQuerySelectArrArgs>(
    ...selections: T
  ): SelectedQuery<RootQueryProjection<T, 'ARRAY'>, D>
  <const T extends RootQuerySelectMapArgs>(
    selections: T,
  ): SelectedQuery<RootQueryProjection<T, 'MAP'>, D>
}
interface SubSelect<D extends Dialect> {
  <const T extends SubQuerySelectArrArgs>(
    ...expressions: T
  ): SelectedQuery<SubQueryProjection<T, 'TUPLE'>, D>
  <T extends ExpressionLike>(expression: T): SelectedQuery<SubQueryProjection<T, 'EXPRESSION'>, D>
}
interface BaseSelect<D extends Dialect> {
  <const T extends BaseQuerySelectMapArgs>(selection: T): SelectedQuery<BaseQueryProjection<T>, D>
}
export type EnhancedMutableRootQuery<D extends Dialect = Dialect> = MutableWithoutSelect<
  MutableRootQuery,
  D
> & {
  select: RootSelect<D>
  selectDistinct: RootSelect<D>
}
export type EnhancedMutableSubQuery<D extends Dialect = Dialect> = MutableWithoutSelect<
  MutableSubQuery,
  D
> & {
  select: SubSelect<D>
  selectDistinct: SubSelect<D>
}
export type EnhancedMutableBaseQuery<D extends Dialect = Dialect> = MutableWithoutSelect<
  MutableBaseQuery,
  D
> & {
  select: BaseSelect<D>
  selectDistinct: BaseSelect<D>
}

export interface EnhancedQueryCreator<D extends Dialect = Dialect> {
  <const M extends AtLeastOne<Model>, P extends RootQueryProjection<unknown>>(
    ...args: [...models: M, fn: (q: EnhancedMutableRootQuery<D>, ...tables: Tables<M>) => P]
  ): AtomRootQuery<P>
}
export interface EnhancedBaseQueryCreator<D extends Dialect = Dialect> {
  <const M extends AtLeastOne<Model>, P extends BaseQueryProjection<BaseQuerySelectMapArgs>>(
    ...args: [...models: M, fn: (q: EnhancedMutableBaseQuery<D>, ...tables: Tables<M>) => P]
  ): AtomBaseQuery<P>
}
export interface EnhancedSubQueryCreator<D extends Dialect = Dialect> {
  <const M extends AtLeastOne<Model>, P extends SubQueryProjection<unknown> | void>(
    ...args: [...models: M, fn: (q: EnhancedMutableSubQuery<D>, ...tables: SubTables<M>) => P]
  ): P extends SubQueryProjection<infer E, infer K>
    ? K extends 'EXPRESSION'
      ? AtomExpressionSubQuery<ChainedExpression<E>>
      : AtomTupleSubQuery<E>
    : AtomExpressionSubQuery<ChainedNumExpression<number>>
}
export type EnhancedSqlClient<D extends Dialect = Dialect> = Omit<SqlClient, 'createQuery'> & {
  readonly dialect: D
  readonly dialectProfile: DialectProfile<D>
  readonly fn: QueryFunctions<D>
  createQuery: EnhancedQueryCreator<D>
}

type MutableQuery = MutableRootQuery | MutableBaseQuery | MutableSubQuery
type Call = (...args: unknown[]) => unknown

function selectionsOf(args: readonly unknown[]): readonly unknown[] {
  if (
    args.length === 1 &&
    !isExpression(args[0]) &&
    typeof args[0] === 'object' &&
    args[0] !== null
  ) {
    return Object.values(args[0])
  }
  return args
}

function enhanceQuery(q: MutableQuery, fn: QueryFunctions, dialect: string) {
  if ('fn' in q || 'autoGroupBy' in q)
    throw new QuerySemanticError('API_COLLISION', 'Query already defines fn/autoGroupBy')
  let automatic = false
  let explicitGroup = false
  let closed = false
  let selection: { projection: object; args: readonly unknown[] } | undefined
  const rowPredicates: unknown[] = []
  const having: unknown[] = []
  const orders: unknown[] = []
  const originals = Object.fromEntries(
    ['select', 'selectDistinct', 'groupBy', 'having', 'where', 'orderBy'].map((name) => [
      name,
      Reflect.get(q, name) as Call,
    ]),
  ) as Record<string, Call>
  const apply = (name: string, args: readonly unknown[]) => Reflect.apply(originals[name]!, q, args)
  const assertOpen = () => {
    if (closed)
      throw new QuerySemanticError('QUERY_FINALIZED', 'The query callback has already completed')
  }
  Object.defineProperties(q, {
    fn: { value: fn },
    autoGroupBy: {
      value() {
        assertOpen()
        if (automatic || explicitGroup)
          throw new QuerySemanticError(
            'GROUP_BY_CONFLICT',
            'Choose groupBy() or autoGroupBy() once',
          )
        automatic = true
        return q
      },
    },
  })
  Object.defineProperty(q, 'groupBy', {
    value(...args: unknown[]) {
      assertOpen()
      validateFunctionDialects(args, dialect)
      if (automatic)
        throw new QuerySemanticError(
          'GROUP_BY_CONFLICT',
          'groupBy() and autoGroupBy() are mutually exclusive',
        )
      const result = apply('groupBy', args)
      explicitGroup = true
      return result
    },
  })
  for (const [name, recorded] of [
    ['where', rowPredicates],
    ['orderBy', orders],
  ] as const) {
    Object.defineProperty(q, name, {
      value(...args: unknown[]) {
        assertOpen()
        validateFunctionDialects(args, dialect)
        recorded.push(...args.filter((value) => value !== null && value !== undefined))
        return apply(name, args)
      },
    })
  }
  Object.defineProperty(q, 'having', {
    value(...args: unknown[]) {
      assertOpen()
      validateFunctionDialects(args, dialect)
      having.push(...args.filter((value) => value !== null && value !== undefined))
      return q
    },
  })
  for (const name of ['select', 'selectDistinct']) {
    Object.defineProperty(q, name, {
      value(...args: unknown[]) {
        assertOpen()
        if (selection)
          throw new QuerySemanticError('MULTIPLE_SELECTIONS', 'Select once per query callback')
        const projection = apply(name, args) as object
        selection = { projection, args }
        Object.defineProperty(projection, 'fn', { value: fn })
        for (const method of ['where', 'having', 'orderBy', 'groupBy', 'autoGroupBy']) {
          Object.defineProperty(projection, method, {
            value(...values: unknown[]) {
              Reflect.apply(Reflect.get(q, method) as Call, q, values)
              return projection
            },
          })
        }
        return projection
      },
    })
  }
  return {
    finish(returned: unknown) {
      assertOpen()
      if (
        (selection && returned !== selection.projection) ||
        (!selection && returned !== undefined)
      ) {
        throw new QuerySemanticError(
          'PROJECTION_MISMATCH',
          'Return the selected projection from its owning query callback',
        )
      }
      const selections = selection ? selectionsOf(selection.args) : [fn.constant(1)]
      validateFunctionDialects([...selections, ...rowPredicates, ...having, ...orders], dialect)
      if (having.length > 0 && orders.length > 0) {
        throw new QuerySemanticError(
          'HAVING_ORDER_REQUIRES_STAGE',
          'Upstream renders ORDER BY before HAVING; put ordering on an outer derived query',
        )
      }
      if (automatic) {
        const keys = inferGroupBy(selections, rowPredicates, having, orders, dialect)
        if (keys.length > 0) apply('groupBy', keys)
        else if (having.length > 0)
          throw new QuerySemanticError(
            'GLOBAL_HAVING_REQUIRES_STAGE',
            'Use a baseQuery aggregate and an outer WHERE for global HAVING',
          )
      } else if (having.length > 0 && !explicitGroup) {
        throw new QuerySemanticError(
          'HAVING_REQUIRES_GROUP',
          'Call groupBy() or autoGroupBy() in the query callback',
        )
      }
      if (having.length > 0) apply('having', having)
    },
    close() {
      closed = true
    },
  }
}

type NativeDriver = Exclude<Parameters<typeof nativeNewSqlClient>[0], SqlClient>
export interface BoundClientSource {
  readonly dialect: Dialect
  readonly createQuery: (...args: never[]) => unknown
}
interface ClientBinding {
  readonly driver: NativeDriver
  readonly profile: DialectProfile
  readonly client: EnhancedSqlClient
}
const enhanced = new WeakMap<object, ClientBinding>()

/** Internal binding lookup also guards against mutation of the native driver. */
export function getClientBinding(client: object): ClientBinding | undefined {
  const binding = enhanced.get(client)
  if (
    binding &&
    (Reflect.get(client, 'driver') !== binding.driver ||
      binding.driver.name !== binding.profile.driverName)
  ) {
    throw new QuerySemanticError(
      'CLIENT_DRIVER_CHANGED',
      'A bound client cannot change its native driver',
    )
  }
  return binding
}

/** Adds q.fn and q.autoGroupBy to this native client; never replaces QueryFactory.
 * Driver access is deliberately isolated to the verified @ts-grm/sql 0.0.13 boundary.
 * @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/sql/src/impl/sql_client_impl.ts
 */
export function enhanceClient<const T extends BoundClientSource>(
  client: T,
): EnhancedSqlClient<T['dialect']>
export function enhanceClient(client: SqlClient): EnhancedSqlClient
export function enhanceClient<D extends Dialect>(
  client: SqlClient | BoundClientSource,
  expected: D,
  options?: DialectOptions,
): EnhancedSqlClient<D>
export function enhanceClient(
  client: object,
  expected?: Dialect,
  options: DialectOptions = {},
): unknown {
  const driver = Reflect.get(client, 'driver') as NativeDriver | undefined
  const dialect = resolveDriverFamily(driver)
  if (expected !== undefined && dialect !== expected)
    throw new QuerySemanticError(
      'DIALECT_MISMATCH',
      `${expected} binding cannot use a ${dialect} driver`,
    )
  const existing = getClientBinding(client)
  if (existing) {
    const requested = createDialectProfile(dialect, driver!.name, options, existing.profile)
    if (JSON.stringify(requested) !== JSON.stringify(existing.profile)) {
      throw new QuerySemanticError(
        'CLIENT_ALREADY_BOUND',
        'Derive a new client to change dialect declarations',
      )
    }
    return existing.client
  }
  if (
    'fn' in client ||
    'dialect' in client ||
    'dialectProfile' in client ||
    !Object.isExtensible(client) ||
    Object.getOwnPropertyDescriptor(client, 'createQuery')?.configurable === false
  ) {
    throw new QuerySemanticError(
      'API_COLLISION',
      'Client must permit fn and createQuery extensions',
    )
  }
  const profile = createDialectProfile(dialect, driver!.name, options)
  const adapt =
    (create: Call, receiver: unknown) =>
    (...args: unknown[]) => {
      getClientBinding(client)
      const callback = args.at(-1)
      if (typeof callback !== 'function') throw new TypeError('Expected query callback')
      return Reflect.apply(create, receiver, [
        ...args.slice(0, -1),
        (q: MutableQuery, ...tables: unknown[]) => {
          const scope = enhanceQuery(q, functions, dialect)
          try {
            const projection = Reflect.apply(callback, undefined, [q, ...tables])
            scope.finish(projection)
            return projection
          } finally {
            scope.close()
          }
        },
      ])
    }
  const functions = createQueryFunctions(
    adapt(dsl.subQuery as Call, undefined),
    adapt(dsl.baseQuery as Call, undefined),
    profile,
  )
  Object.defineProperties(client, {
    dialect: { value: dialect },
    dialectProfile: { value: profile },
    fn: { value: functions },
    createQuery: {
      value: adapt(Reflect.get(client, 'createQuery') as Call, client),
      configurable: true,
      writable: true,
    },
  })
  const result = client as unknown as EnhancedSqlClient
  enhanced.set(client, { client: result, driver: driver!, profile })
  return result
}
