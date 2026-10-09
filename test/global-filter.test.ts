import { EntityManager, model, prop, spi } from '@ts-grm/core'
import type { SqlClient } from '@ts-grm/core'
import { FilterManager, newSqlClient, PostgresDriver } from '@ts-grm/sql'
import { describe, expect, it } from 'vitest'

import { installGlobalFilters } from '../src/index'
import type { GlobalFilter } from '../src/index'

const ORDER = model(
  'GfOrder',
  'id',
  class {
    id = prop.i32()
    tenantId = prop.i32()
  },
)

const AUDIT = model(
  'GfAudit',
  'id',
  class {
    id = prop.i32()
  },
)

function entityOf(target: unknown): spi.Entity {
  return spi.Entity.of(target as never)
}

function clientWith(filterManager?: FilterManager): SqlClient {
  return newSqlClient(new PostgresDriver({} as never), {
    entityManager: EntityManager.combine(ORDER as never, AUDIT as never),
    ...(filterManager == null ? {} : { filterManager }),
  })
}

/** `getFilters` 在公开的 SqlClientImplementor 上，但不在 SqlClient 类型里。 */
function filtersOf(client: SqlClient, entity: spi.Entity): ReadonlyArray<unknown> {
  return (client as unknown as { getFilters(e: spi.Entity): ReadonlyArray<unknown> }).getFilters(
    entity,
  )
}

/** 只用于计数、不对任何模型真正生效的过滤器。 */
const noopFilter: GlobalFilter = () => undefined

describe('installGlobalFilters', () => {
  it('全局过滤器对所有模型生效，无需逐个登记', () => {
    const client = clientWith()
    installGlobalFilters(client).addGlobal(noopFilter)

    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(1)
  })

  it('注册后立即生效，不必赶在创建 client 之前', () => {
    const client = clientWith()
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(0)

    installGlobalFilters(client).addGlobal(noopFilter)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
  })

  it('与上游 add(model, filter) 的模型级过滤器叠加', () => {
    const filterManager = new FilterManager()
    filterManager.add(ORDER as never, noopFilter as never)

    const client = clientWith(filterManager)
    installGlobalFilters(client).addGlobal(noopFilter)

    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(2)
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(1)
  })

  it('反复查询不会重复累积全局过滤器', () => {
    const client = clientWith()
    installGlobalFilters(client).addGlobal(noopFilter)

    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
  })

  it('忽略 undefined，并支持链式调用', () => {
    const client = clientWith()
    const manager = installGlobalFilters(client)

    expect(manager.addGlobal(undefined)).toBe(manager)
    manager.addGlobal(noopFilter).addGlobal(noopFilter)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(2)
  })

  it('globalFilters 返回快照，外部修改不影响内部', () => {
    const client = clientWith()
    const manager = installGlobalFilters(client)
    manager.addGlobal(noopFilter)

    const snapshot = manager.globalFilters as GlobalFilter[]
    snapshot.push(noopFilter)

    expect(manager.globalFilters).toHaveLength(1)
  })

  it('不改变上游行为：没有全局过滤器时与普通 client 一致', () => {
    const filterManager = new FilterManager()
    filterManager.add(ORDER as never, noopFilter as never)

    const client = clientWith(filterManager)
    installGlobalFilters(client)

    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(0)
  })

  it('client 不提供 getFilters 时明确报错，而不是静默失效', () => {
    expect(() => installGlobalFilters({} as never)).toThrow(/getFilters/)
  })
})
