import { dsl, dto, model, prop } from '@ts-grm/core'
import type {
  MutableRootQuery,
  MutableSubQuery,
  MutableBaseQuery,
  SqlClient,
  Table,
} from '@ts-grm/core'
import type { EnhancedSqlClient } from '../src/index'
import { newSqlClient } from '../src/index'

const MODEL = model(
  'NativeCompatTypes',
  'id',
  class {
    id = prop.i32()
    name = prop.str(30)
  },
)
const VIEW = dto.view(MODEL, (c) => [c.id, c.name])

function nativeProjection(q: MutableRootQuery, t: Table<typeof MODEL>) {
  return q.where(t.id.gt(0)).select({ id: t.id, name: t.name })
}
function nativeRepository(client: SqlClient) {
  return client.createQuery(MODEL, nativeProjection).fetchList()
}

/** Native interfaces remain usable by existing helpers and generic creators. */
export function checkNativeCompatibility(client: EnhancedSqlClient<'postgres'>, raw: SqlClient) {
  client.createQuery(MODEL, (q, t) => {
    // @ts-expect-error Logical chains require a Predicate receiver.
    t.id.and(t.id.eq(1))
    const n: import('@ts-grm/core').NumExpression<number> = t.id.sum().abs().coalesce(0)
    return q.select(n)
  })
  const native: SqlClient = client
  const create: SqlClient['createQuery'] = client.createQuery
  const base: typeof dsl.baseQuery = client.fn.baseQuery
  const sub: typeof dsl.subQuery = client.fn.subQuery
  const rows: Promise<Array<{ readonly id: number; readonly name: string }>> =
    nativeRepository(client)
  const selected: Promise<Array<{ readonly id: number; readonly name: string }>> = client
    .createQuery(MODEL, nativeProjection)
    .fetchList()
  client.createQuery(MODEL, (q, t) => {
    const original: MutableRootQuery = q
    const select: MutableRootQuery['select'] = q.select
    void [original, select]
    return q.where(t.id.gt(0), t.id.lt(10)).select(t.fetch(VIEW))
  })
  client.fn.subQuery(MODEL, (q, t) => {
    const original: MutableSubQuery = q
    void original
    return q.where(t.id.gt(0)).select(t.id)
  })
  client.fn.baseQuery(MODEL, (q, t) => {
    const original: MutableBaseQuery = q
    void original
    return q.where(t.id.gt(0)).select({ id: t.id })
  })
  const derived: EnhancedSqlClient = newSqlClient(raw)
  const recursive = client.fn
    .baseQuery(MODEL, (q, t) => q.select({ id: t.id }))
    .unionAllRecursively(MODEL, {
      join: (prev, t) => prev.id.eq(t.id),
      query: (q, t) => q.select({ id: t.id }),
    })
  const recursiveFunction = client.fn
    .baseQuery(MODEL, (q, t) => q.select({ id: t.id, depth: q.fn.constant(0) }))
    .unionAllRecursively(MODEL, {
      join: (prev, t) => prev.id.eq(t.id),
      query: (q, t) => q.select({ id: t.id, depth: q.prev.depth.plus(1) }),
    })
  const nativeBranch = raw.createQuery(MODEL, (q, t) => q.select(t.id))
  const enhancedBranch = client.createQuery(MODEL, (q) => q.select(q.fn.constant(1)))
  const combined = dsl.union(nativeBranch, enhancedBranch)
  const stage = client.fn.derivedModel(
    client.fn.baseQuery(MODEL, (q) => q.select({ depth: q.fn.constant(0) })),
  )
  client.createQuery(stage, (q, t) => {
    t.depth.abs()
    return q.select(q.fn.abs(t.depth).round())
  })
  const tuples: Promise<readonly (readonly [number, string])[]> = client
    .createQuery(MODEL, MODEL, (q, left, right) => {
      q.fn.postgres.jsonbExtractPathText('{}', 'name')
      // @ts-expect-error Multiple-model callbacks still retain the bound family.
      void q.fn.mysql
      return q.where(left.id.eq(right.id), left.id.gt(0)).select(left.id, right.name)
    })
    .fetchList()
  // @ts-expect-error Native SqlClient erases the specific driver's family.
  void derived.fn.mysql
  void [native, create, base, sub, rows, selected, tuples, recursive, recursiveFunction, combined]
}
