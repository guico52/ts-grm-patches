import { type EntityManager, spi } from '@ts-grm/core'
import type { AnyModel, Predicate } from '@ts-grm/core'
import { FilterManager } from '@ts-grm/sql'
import type { AnyFilter } from '@ts-grm/sql'

/** 对所有模型生效的过滤器（与上游 per-model 的 `Filter` 同形）。 */
export type GlobalFilter = AnyFilter

export interface GlobalFilterManager extends FilterManager {
  /**
   * 对**所有**传入的模型注册过滤器。
   *
   * 因为无法预知过滤器内部的逻辑，这种方式会被视为「处处适用」，因此这些模型的
   * `getFilters(entity)` 都会非空 —— 上游据此判断关联查询能否直接读取外键，
   * 代价是会放弃该优化。需要按列过滤时请用 `addGlobalFor()`。
   */
  addGlobal(filter: GlobalFilter | undefined): this

  /**
   * 只对**拥有该列**的模型注册过滤器，其余模型完全不注册。
   *
   * 缺少该列的模型拿到的是**空列表**，上游的关联查询优化得以保留，
   * 同时也不会因访问不存在的列而抛错。
   *
   * ```ts
   * globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(tenantId))
   * ```
   */
  addGlobalFor<TColumn = unknown>(
    column: string,
    build: (column: TColumn) => Predicate | undefined,
  ): this

  /** 已注册的全局过滤器（快照）。 */
  readonly globalFilters: ReadonlyArray<GlobalFilter>

  /**
   * 返回在给定模型中**都不存在**的列名 —— 用于发现 `addGlobalFor()` 的拼写错误。
   */
  unknownColumns(models: ReadonlyArray<AnyModel>): ReadonlyArray<string>
}

/**
 * 该模型是否拥有该属性。
 *
 * 用实体元数据（`allPropMap`，包含继承来的属性）判断 —— 与上游生成 table 字段的来源一致：
 * 实测在普通属性、继承属性、embedded、关联及其自动外键上，它与 `column in table` 的结果
 * 完全相同。相比构造 table 实例，这里不需要 try/catch：实体解析出问题时会直接暴露，
 * 而不是被当成「没有这一列」。
 */
function entityHasColumn(entity: spi.Entity, column: string): boolean {
  return entity.allPropMap.has(column)
}

/**
 * 创建一个**原生 `FilterManager`**，它把过滤器注册到目标模型上。
 *
 * 直接作为 `newSqlClient` 的 `filterManager` 选项使用：
 *
 * ```ts
 * const globalFilters = await createGlobalFilterManager(entityManager)
 * globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(tenantId))
 *
 * const client = newSqlClient(driver, { entityManager, filterManager: globalFilters })
 * ```
 *
 * 模型来自 `EntityManager` 时**不必手写清单** —— 上游的 `entities()` 已经沿继承链汇总了
 * 全部相关实体（`_add` 会递归加入 `superEntity`），这里再用 `Entity.model` 取回模型。
 * 因为那个方法异步，所以本函数也是异步的；同时仍接受模型数组。
 *
 * 相比「包装 `getFilters()`」，这种方式不触碰上游内部：
 *
 * - `getFilters(entity)` 天然精确 —— 只有真正注册过的模型才非空，上游据此保留
 *   关联查询直接读外键的优化（`association_resolver.ts` 的 `length === 0`）；
 * - 走公开的 `filterManager` 选项，`newSqlClient(client, options)` 派生的客户端会
 *   自然继承（实例在 options 里传递）；
 * - 不依赖任何私有成员，也不需要在客户端上做任何替换。
 *
 * 代价与边界：
 *
 * - 与上游一致，过滤器在客户端构造时被快照，因此要在 `newSqlClient()` **之前**注册完毕；
 * - 传 `EntityManager` 时涵盖其中**所有**模型 —— 注意 `combine()` 只给出显式传入的部分，
 *   而 `of(baseDir, paths)` 枚举的是进程内**全部已注册模型**（其 `paths` 只负责触发模块
 *   加载）。不在集合中的模型本身不会被注册，但若它的某个祖先在集合中且适用，它仍会通过
 *   上游的继承链拿到该过滤器。
 */
export async function createGlobalFilterManager(
  source: EntityManager | ReadonlyArray<AnyModel>,
): Promise<GlobalFilterManager> {
  const models = await resolveModels(source)
  const manager = new FilterManager() as GlobalFilterManager
  const registered: GlobalFilter[] = []
  const knownColumns: string[] = []

  // 按实体去重：同一个实体只处理一次
  const listed = [
    ...new Map(
      models.map((model) => {
        const entity = spi.Entity.of(model as never)
        return [entity, { entity, model }] as const
      }),
    ).values(),
  ]
  const listedEntities = new Set(listed.map((entry) => entry.entity))

  /**
   * 上游构造过滤器列表时会沿 `superEntity` 链逐级收集（`_createFilters`），
   * 所以若某个「在清单中且适用」的祖先已经贡献了同一个过滤器，本实体就不能再注册，
   * 否则同一个条件会出现两次。反过来，只存在于子模型上的列不会被祖先覆盖，
   * 该子模型仍需自己注册。
   */
  function hasApplicableListedAncestor(
    entity: spi.Entity,
    applies: (entity: spi.Entity) => boolean,
  ): boolean {
    for (let e: spi.Entity | undefined = entity.superEntity; e != null; e = e.superEntity) {
      if (listedEntities.has(e) && applies(e)) {
        return true
      }
    }
    return false
  }

  function register(filter: GlobalFilter, applies: (entity: spi.Entity) => boolean): void {
    registered.push(filter)
    for (const { entity, model } of listed) {
      if (applies(entity) && !hasApplicableListedAncestor(entity, applies)) {
        manager.add(model as never, filter)
      }
    }
  }

  Object.defineProperties(manager, {
    addGlobal: {
      value(filter: GlobalFilter | undefined) {
        if (filter != null) {
          register(filter, () => true)
        }
        return manager
      },
    },
    addGlobalFor: {
      value(column: string, build: (column: unknown) => Predicate | undefined) {
        if (!knownColumns.includes(column)) {
          knownColumns.push(column)
        }
        register(
          (table) => {
            const onTable = (table as unknown as Record<string, unknown>)[column]
            if (onTable == null) {
              return undefined
            }
            return build(onTable)
          },
          (entity) => entityHasColumn(entity, column),
        )
        return manager
      },
    },
    globalFilters: {
      get: () => [...registered],
    },
    unknownColumns: {
      value: (others: ReadonlyArray<AnyModel>) =>
        knownColumns.filter(
          (column) => !others.some((m) => entityHasColumn(spi.Entity.of(m as never), column)),
        ),
    },
  })

  return manager
}

/**
 * 把两种输入统一成模型数组。
 *
 * `EntityManager.entities()` 给出的是 `Entity`（且已包含继承链），而 `FilterManager.add()`
 * 需要模型，所以用 `Entity.model` 取回 —— 该属性是上游的公开字段。
 */
async function resolveModels(
  source: EntityManager | ReadonlyArray<AnyModel>,
): Promise<ReadonlyArray<AnyModel>> {
  if (isModelArray(source)) {
    return source
  }
  const entities = await source.entities()
  return [...entities].map((entity) => entity.model)
}

function isModelArray(
  source: EntityManager | ReadonlyArray<AnyModel>,
): source is ReadonlyArray<AnyModel> {
  return Array.isArray(source)
}
