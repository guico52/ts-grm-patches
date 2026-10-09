import { EntityManager, model, prop, spi } from '@ts-grm/core'
import type { NumExpression, SqlClient } from '@ts-grm/core'
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

/**
 * 构造上游在查询期真正传给过滤器的对象：table 类是按实体的声明属性逐个生成的
 * （core 的 createEntityTableClass），所以不含该列的模型上属性就是 undefined。
 */
function tableOf(entity: spi.Entity): Record<string, unknown> {
  const ctor = (
    entity as unknown as {
      tableClass(): new (e: spi.Entity, join: unknown) => Record<string, unknown>
    }
  ).tableClass()
  return new ctor(entity, undefined)
}

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

  it('addGlobalFor 只在模型拥有该列时应用，缺少该列的模型被跳过', () => {
    const client = clientWith()
    installGlobalFilters(client).addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    const filter = filtersOf(client, entityOf(ORDER))[0] as (table: unknown) => unknown
    expect(filter(tableOf(entityOf(ORDER)))).toBeDefined()
    // 关键：跳过而不是抛错
    expect(filter(tableOf(entityOf(AUDIT)))).toBeUndefined()
  })

  it('缺列实体在 getFilters 阶段就返回空数组，保住关联查询的直接读外键优化', () => {
    const client = clientWith()
    installGlobalFilters(client).addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    // 上游据 getFilters(...).length === 0 决定关联能否直接读取外键
    // （association_resolver.ts:127）
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(0)
  })

  it('对照：addGlobal() 无法预判适用性，对缺列实体也返回非空（会放弃关联优化）', () => {
    const client = clientWith()
    installGlobalFilters(client).addGlobal(noopFilter)

    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(1)
  })

  it('对同一个 client 重复安装是幂等的，返回同一个管理器', () => {
    const client = clientWith()
    const first = installGlobalFilters(client)
    const second = installGlobalFilters(client)

    expect(second).toBe(first)
    second.addGlobal(noopFilter)
    // 若重复包装，这里会变成 2
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
  })

  it('派生客户端不会继承包装，需显式安装并可共享同一批过滤器', () => {
    const base = clientWith()
    const manager = installGlobalFilters(base)
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    // 上游 newSqlClient(client, options) 会新建实例
    const derived = newSqlClient(base, {})
    expect(filtersOf(derived, entityOf(ORDER))).toHaveLength(0)

    installGlobalFilters(derived, manager)
    expect(filtersOf(derived, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(derived, entityOf(AUDIT))).toHaveLength(0)
  })

  it('传入非本包创建的管理器时明确报错', () => {
    const client = clientWith()
    const foreign = {
      addGlobal: () => foreign,
      globalFilters: [],
      unknownColumns: () => [],
    }
    expect(() => installGlobalFilters(client, foreign as never)).toThrow(
      /not created by this package/,
    )
  })

  it('unknownColumns 报出拼错的列名，避免过滤器静默失效', () => {
    const client = clientWith()
    const manager = installGlobalFilters(client)
    manager.addGlobalFor('tenantId', () => undefined)
    manager.addGlobalFor('tenandId', () => undefined)

    expect(manager.unknownColumns([ORDER as never, AUDIT as never])).toEqual(['tenandId'])
  })

  it('对照组：直接访问缺失的列会抛错 —— 这正是 addGlobalFor 要防的', () => {
    const auditTable = tableOf(entityOf(AUDIT)) as {
      tenantId?: { eq(value: number): unknown }
    }
    expect(auditTable.tenantId).toBeUndefined()
    expect(() => auditTable.tenantId!.eq(1)).toThrow(TypeError)
  })
})
