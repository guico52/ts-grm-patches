import { EntityManager, model, prop, spi } from '@ts-grm/core'
import { FilterManager, newSqlClient, PostgresDriver } from '@ts-grm/sql'
import { describe, expect, it } from 'vitest'

import { createGlobalFilterManager } from '../src/index'
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

/** 读取 `getFilters`（它在 SqlClientImplementor 上，不在公开 SqlClient 类型里）。 */
function clientWith(manager: FilterManager): {
  getFilters(entity: spi.Entity): ReadonlyArray<unknown>
} {
  return newSqlClient(new PostgresDriver({} as never), {
    entityManager: EntityManager.combine(ORDER as never, AUDIT as never),
    filterManager: manager,
  }) as unknown as { getFilters(entity: spi.Entity): ReadonlyArray<unknown> }
}

/** 一个不对任何模型真正生效、只用于计数的全局过滤器。 */
const noopFilter: GlobalFilter = () => undefined

describe('createGlobalFilterManager', () => {
  it('全局过滤器对所有模型生效，无需逐个登记', () => {
    const manager = createGlobalFilterManager()
    manager.addGlobal(noopFilter)

    const client = clientWith(manager)
    expect(client.getFilters(entityOf(ORDER))).toHaveLength(1)
    expect(client.getFilters(entityOf(AUDIT))).toHaveLength(1)
  })

  it('与上游 add(model, filter) 的模型级过滤器叠加', () => {
    const manager = createGlobalFilterManager()
    manager.add(ORDER as never, noopFilter as never)
    manager.addGlobal(noopFilter)

    const client = clientWith(manager)
    expect(client.getFilters(entityOf(ORDER))).toHaveLength(2)
    expect(client.getFilters(entityOf(AUDIT))).toHaveLength(1)
  })

  it('忽略 undefined，并支持链式调用', () => {
    const manager = createGlobalFilterManager()
    expect(manager.addGlobal(undefined)).toBe(manager)

    manager.addGlobal(noopFilter).addGlobal(noopFilter)

    const client = clientWith(manager)
    expect(client.getFilters(entityOf(ORDER))).toHaveLength(2)
  })

  it('globalFilters 返回快照，外部修改不影响内部', () => {
    const manager = createGlobalFilterManager()
    manager.addGlobal(noopFilter)

    const snapshot = manager.globalFilters as GlobalFilter[]
    snapshot.push(noopFilter)

    expect(manager.globalFilters).toHaveLength(1)
  })

  it('客户端构造后注册的全局过滤器不生效（上游在构造时做快照）', () => {
    const manager = createGlobalFilterManager()
    const client = clientWith(manager)
    expect(client.getFilters(entityOf(ORDER))).toHaveLength(0)

    manager.addGlobal(noopFilter)
    expect(client.getFilters(entityOf(ORDER))).toHaveLength(0)
  })

  it('不改变上游行为：没有全局过滤器时与普通 FilterManager 一致', () => {
    const manager = createGlobalFilterManager()
    manager.add(ORDER as never, noopFilter as never)

    const client = clientWith(manager)
    expect(client.getFilters(entityOf(ORDER))).toHaveLength(1)
    expect(client.getFilters(entityOf(AUDIT))).toHaveLength(0)
  })
})
