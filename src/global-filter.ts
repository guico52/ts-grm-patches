import type { Predicate, SqlClient, spi } from '@ts-grm/core'
import type { AnyFilter } from '@ts-grm/sql'

/**
 * 对所有模型生效的过滤器。
 *
 * 与上游 per-model 的 `Filter` 同形。过滤器收到的 table 是上游查询期对象，
 * 其 `__entity` 指向当前的 `spi.Entity`，可用它把过滤器限定到或排除掉特定模型。
 */
export type GlobalFilter = AnyFilter

export interface GlobalFilterManager {
  /**
   * 注册一个对**所有**模型生效的过滤器。
   *
   * 与上游在 client 构造时快照 `filterManager` 不同，这里注册后**立即生效**，
   * 不必赶在 `newSqlClient()` 之前。
   *
   * 注意：上游的 table 是按实体的声明属性逐个生成的，**不含该列的模型上属性为
   * `undefined`**，直接 `table.xxx.eq(...)` 会抛 `TypeError` 并打断查询。
   * 需要按列过滤时请优先使用 `addGlobalFor()`，或自行用可选链判断，
   * 例如 `(table) => table.tenantId?.eq(id)`。
   */
  addGlobal(filter: GlobalFilter | undefined): this

  /**
   * 声明式注册：**只在模型确实拥有该列时**才应用过滤器。
   *
   * 适合「软删除」「多租户」这类需要覆盖所有模型、但各模型列不一定齐全的场景：
   * 缺少该列的模型会被自动跳过（过滤器返回 `undefined`，上游会忽略它），
   * 而不是抛错。
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
}

interface FiltersHolder {
  getFilters(entity: spi.Entity): ReadonlyArray<AnyFilter>
}

/**
 * 让一个已创建的 client 具备全局过滤器能力。
 *
 * 上游 `FilterManager.add()` 必须绑定具体模型，没有「对所有模型生效」的能力，
 * 因此这里改在公开接口 `getFilters(entity)` 上叠加 —— 它是
 * `SqlClientImplementor` 的成员（受 semver 保护），入参就是原始实体，
 * 且其内部的过滤器缓存不受影响。
 *
 * 选择这条通道还避开了 `FilterManager` 那条私有 `_toMap()` 路径：
 * 后者在上游只有一处调用、且以 `as any` 强转私有方法，改名不需要发大版本；
 * 同时 client 会在构造时快照过滤器，注册时机也受限。
 *
 * 若当前 client 没有 `getFilters`（上游接口发生变化），这里会直接抛错，
 * 而不是静默失效。
 */
export function installGlobalFilters(client: SqlClient): GlobalFilterManager {
  const holder = client as unknown as Partial<FiltersHolder>
  if (typeof holder.getFilters !== 'function') {
    throw new Error(
      'installGlobalFilters(): the SqlClient does not expose getFilters(); ' +
        'the installed @ts-grm/sql is not supported by this patch version.',
    )
  }

  const globalFilters: GlobalFilter[] = []
  const original = holder.getFilters.bind(client)

  holder.getFilters = (entity: spi.Entity) => {
    const own = original(entity)
    if (globalFilters.length === 0) {
      return own
    }
    return [...globalFilters, ...own]
  }

  return {
    addGlobal(filter: GlobalFilter | undefined) {
      if (filter != null) {
        globalFilters.push(filter)
      }
      return this
    },
    addGlobalFor<TColumn>(column: string, build: (column: TColumn) => Predicate | undefined) {
      return this.addGlobal((table) => {
        const onTable = (table as unknown as Record<string, unknown>)[column]
        if (onTable == null) {
          // 该模型没有这一列：跳过而不是抛错
          return undefined
        }
        return build(onTable as TColumn)
      })
    },
    get globalFilters() {
      return [...globalFilters]
    },
  }
}
