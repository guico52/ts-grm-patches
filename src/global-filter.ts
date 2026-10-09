import { spi } from '@ts-grm/core'
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
   * 这是与 `addGlobal()` 的关键差别：缺少该列的模型拿到的是**空列表**，
   * 上游的关联查询优化得以保留，同时也不会因访问不存在的列而抛错。
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
   *
   * 列名写错时该过滤器不会注册到任何模型，这里让它可以被显式检查。
   */
  unknownColumns(models: ReadonlyArray<AnyModel>): ReadonlyArray<string>
}

/**
 * 该模型的 table 上是否存在这一列。
 *
 * 上游的 table 类是按实体的声明属性（含继承）生成的，所以用运行时真值判断。
 */
function tableHasColumn(model: AnyModel, column: string): boolean {
  try {
    const entity = spi.Entity.of(model as never)
    const ctor = (
      entity as unknown as {
        tableClass(): new (e: spi.Entity, join: unknown) => object
      }
    ).tableClass()
    return column in new ctor(entity, undefined)
  } catch {
    // 判断不出来就不注册：注册了也不会真正生效（过滤器自身会返回 undefined），
    // 却会让 getFilters() 非空，反而破坏上游对关联查询的优化判断。
    return false
  }
}

/**
 * 创建一个**原生 `FilterManager`**，它把过滤器注册到传入的每个模型上。
 *
 * 直接作为 `newSqlClient` 的 `filterManager` 选项使用：
 *
 * ```ts
 * const globalFilters = createGlobalFilterManager([ORDER, CUSTOMER])
 * globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(tenantId))
 *
 * const client = newSqlClient(driver, { entityManager, filterManager: globalFilters })
 * ```
 *
 * 相比「包装 `getFilters()`」，这种方式不触碰上游内部：
 *
 * - `getFilters(entity)` 天然精确 —— 只有真正注册过的模型才非空，上游据此保留
 *   关联查询直接读外键的优化（`association_resolver.ts` 的 `length === 0`）；
 * - 走公开的 `filterManager` 选项，`newSqlClient(client, options)` 派生的客户端会
 *   自然继承（实例在 options 里传递）；
 * - 不依赖任何私有成员，也不需要在客户端上做任何替换。
 *
 * 代价是需要提供模型清单，并且与上游一致：过滤器在客户端构造时被快照，
 * 因此要在 `newSqlClient()` **之前**注册完毕。未列入 `models` 的模型不会被过滤。
 */
export function createGlobalFilterManager(models: ReadonlyArray<AnyModel>): GlobalFilterManager {
  const manager = new FilterManager() as GlobalFilterManager
  const registered: GlobalFilter[] = []
  const knownColumns: string[] = []

  // 按实体去重：同一个实体只注册一次，避免产生重复谓词
  const targets = [...new Map(models.map((m) => [spi.Entity.of(m as never), m])).values()]

  function register(filter: GlobalFilter, applies: (model: AnyModel) => boolean): void {
    registered.push(filter)
    for (const model of targets) {
      if (applies(model)) {
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
          (model) => tableHasColumn(model, column),
        )
        return manager
      },
    },
    globalFilters: {
      get: () => [...registered],
    },
    unknownColumns: {
      value: (others: ReadonlyArray<AnyModel>) =>
        knownColumns.filter((column) => !others.some((m) => tableHasColumn(m, column))),
    },
  })

  return manager
}
