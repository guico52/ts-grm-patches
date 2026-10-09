import {
  DISCRIMINATOR_VALUE_MODEL_NAME,
  EntityManager,
  TABLE_INHERIT,
  model,
  prop,
  spi,
} from '@ts-grm/core'
import type { NumExpression, SqlClient, StrExpression } from '@ts-grm/core'
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

// CHILD 自身不声明 tenantId，它是从 PARENT 继承来的
const PARENT = model(
  'GfBase',
  'id',
  class {
    id = prop.i32()
    tenantId = prop.i32()
  },
  (ctx) => {
    ctx.table({ discriminator: 'TYPE', discriminatorValue: DISCRIMINATOR_VALUE_MODEL_NAME })
  },
)

const CHILD = model.extends(PARENT)(
  'GfChild',
  class {
    name = prop.str(20)
  },
  (ctx) => {
    ctx.table({ name: TABLE_INHERIT, discriminatorValue: DISCRIMINATOR_VALUE_MODEL_NAME })
  },
)

// 故意不列入 createGlobalFilterManager 的模型清单
const UNLISTED = model(
  'GfUnlisted',
  'id',
  class {
    id = prop.i32()
    tenantId = prop.i32()
  },
)

const LISTED = [ORDER, AUDIT, PARENT, CHILD]

function entityOf(target: unknown): spi.Entity {
  return spi.Entity.of(target as never)
}

function clientWith(filterManager?: FilterManager): SqlClient {
  return newSqlClient(new PostgresDriver({} as never), {
    entityManager: EntityManager.combine(
      EntityManager.combine(
        EntityManager.combine(ORDER as never, AUDIT as never),
        EntityManager.combine(CHILD as never, UNLISTED as never),
      ),
      PARENT as never,
    ),
    ...(filterManager == null ? {} : { filterManager }),
  })
}

function filtersOf(client: SqlClient, entity: spi.Entity): ReadonlyArray<unknown> {
  return (client as unknown as { getFilters(e: spi.Entity): ReadonlyArray<unknown> }).getFilters(
    entity,
  )
}

/** table 类是按实体的声明属性生成的，这样能拿到查询期真正传给过滤器的那种对象。 */
function tableOf(entity: spi.Entity): Record<string, unknown> {
  const ctor = (
    entity as unknown as {
      tableClass(): new (e: spi.Entity, join: unknown) => Record<string, unknown>
    }
  ).tableClass()
  return new ctor(entity, undefined)
}

describe('createGlobalFilterManager', () => {
  it('返回的是上游原生 FilterManager 实例', async () => {
    expect(await createGlobalFilterManager(LISTED)).toBeInstanceOf(FilterManager)
  })

  it('可以直接接受 EntityManager，无需手写模型清单', async () => {
    const entityManager = EntityManager.combine(
      EntityManager.combine(ORDER as never, AUDIT as never),
      CHILD as never,
    )
    const manager = await createGlobalFilterManager(entityManager)
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    const client = clientWith(manager)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    // entities() 已经包含继承链；子模型由祖先贡献，不会重复
    expect(filtersOf(client, entityOf(CHILD))).toHaveLength(1)
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(0)
  })

  it('只为拥有该列的模型注册：缺列模型的 getFilters 是空数组', async () => {
    const manager = await createGlobalFilterManager([ORDER, AUDIT])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    const client = clientWith(manager)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    // 上游据 getFilters(...).length === 0 判断关联能否直接读取外键
    // （association_resolver.ts），空数组才能保住该优化
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(0)
  })

  it('继承来的列也算拥有该列', async () => {
    const manager = await createGlobalFilterManager([CHILD])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    expect(filtersOf(clientWith(manager), entityOf(CHILD))).toHaveLength(1)
  })

  it('addGlobal 对所有列出的模型生效', async () => {
    const manager = await createGlobalFilterManager([ORDER, AUDIT])
    manager.addGlobal(() => undefined)

    const client = clientWith(manager)
    expect(filtersOf(client, entityOf(ORDER))).toHaveLength(1)
    expect(filtersOf(client, entityOf(AUDIT))).toHaveLength(1)
  })

  it('过滤器执行时缺列返回 undefined（上游会忽略），不抛错', async () => {
    const manager = await createGlobalFilterManager([ORDER, AUDIT])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    const filter = manager.globalFilters[0] as (table: unknown) => unknown
    expect(filter(tableOf(entityOf(ORDER)))).toBeDefined()
    expect(filter(tableOf(entityOf(AUDIT)))).toBeUndefined()
  })

  it('经 filterManager 选项传递时被上游原样保留（不被 merge 浅拷贝破坏）', async () => {
    const manager = await createGlobalFilterManager([ORDER])
    const client = clientWith(manager)

    // 上游 merge() 只对白名单构造器（FilterManager / EntityManager）原样放行，
    // 其他对象会被 {...value} 浅拷贝而丢失原型 —— 这里钉住该前提
    const options = (client as unknown as { options: { filterManager?: unknown } }).options
    expect(options.filterManager).toBe(manager)
  })

  it('派生客户端自动继承（实例在 options 里传递）', async () => {
    const manager = await createGlobalFilterManager([ORDER])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    const base = clientWith(manager)
    expect(filtersOf(newSqlClient(base, {}), entityOf(ORDER))).toHaveLength(1)
  })

  it('未列入 models 且无适用祖先的模型不会被过滤', async () => {
    const manager = await createGlobalFilterManager([ORDER])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    expect(filtersOf(clientWith(manager), entityOf(UNLISTED))).toHaveLength(0)
  })

  it('父子同时列入时不会重复注册（上游会沿 superEntity 链收集）', async () => {
    const manager = await createGlobalFilterManager([PARENT, CHILD])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(7))

    const client = clientWith(manager)
    expect(filtersOf(client, entityOf(PARENT))).toHaveLength(1)
    // 子模型的过滤器由祖先贡献，不能重复注册（否则条件会出现两次）
    expect(filtersOf(client, entityOf(CHILD))).toHaveLength(1)
  })

  it('未列入清单的子模型仍会通过继承链拿到祖先的过滤器', async () => {
    const manager = await createGlobalFilterManager([PARENT])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(7))

    expect(filtersOf(clientWith(manager), entityOf(CHILD))).toHaveLength(1)
  })

  it('只存在于子模型的列仍由子模型自己注册', async () => {
    const manager = await createGlobalFilterManager([PARENT, CHILD])
    manager.addGlobalFor<StrExpression<string>>('name', (t) => t.eq('x'))

    const client = clientWith(manager)
    expect(filtersOf(client, entityOf(CHILD))).toHaveLength(1)
    expect(filtersOf(client, entityOf(PARENT))).toHaveLength(0)
  })

  it('同一模型重复传入只注册一次', async () => {
    const manager = await createGlobalFilterManager([ORDER, ORDER])
    manager.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(1))

    expect(filtersOf(clientWith(manager), entityOf(ORDER))).toHaveLength(1)
  })

  it('unknownColumns 报出拼错的列名，继承列不算未知', async () => {
    const manager = await createGlobalFilterManager([ORDER])
    manager.addGlobalFor('tenantId', () => undefined)
    manager.addGlobalFor('tenandId', () => undefined)

    expect(manager.unknownColumns([ORDER as never, AUDIT as never])).toEqual(['tenandId'])
    expect(manager.unknownColumns([CHILD as never])).toEqual(['tenandId'])
  })

  it('globalFilters 返回快照，外部修改不影响内部', async () => {
    const manager = await createGlobalFilterManager([ORDER])
    manager.addGlobal(() => undefined)

    const snapshot = manager.globalFilters as GlobalFilter[]
    snapshot.push(() => undefined)
    expect(manager.globalFilters).toHaveLength(1)
  })
})
