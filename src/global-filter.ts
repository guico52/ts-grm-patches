import type { spi } from '@ts-grm/core'
import { FilterManager } from '@ts-grm/sql'
import type { AnyFilter } from '@ts-grm/sql'

/**
 * 对所有模型生效的过滤器。
 *
 * 与上游 per-model 的 `Filter` 同形，因此在过滤器内部可以按
 * `table.__entity.name` 之类的信息决定是否真正应用。
 */
export type GlobalFilter = AnyFilter

export interface GlobalFilterManager extends FilterManager {
  /**
   * 注册一个对**所有**模型生效的过滤器。
   *
   * 同一实体上，全局过滤器排在上游 `add(model, filter)` 注册的模型级过滤器之前，
   * 各自按注册顺序叠加。
   */
  addGlobal(filter: GlobalFilter | undefined): this

  /** 已注册的全局过滤器（快照）。 */
  readonly globalFilters: ReadonlyArray<GlobalFilter>
}

interface FilterMapCarrier {
  _toMap(): ReadonlyMap<spi.Entity, ReadonlyArray<AnyFilter>> | undefined
}

/**
 * 创建全局过滤器管理器，可直接交给 `newSqlClient` 的 `filterManager` 选项。
 *
 * 上游 `FilterManager.add()` 必须绑定具体模型，没有「对所有模型生效」的能力；
 * 而它向消费方暴露过滤器的通道是私有的 `_toMap()`。这里保留那条通道的形状，
 * 用一个 Proxy 在其 `get()` 上叠加全局过滤器 —— 因此**不需要枚举模型**，
 * 任何实体的查询都会拿到它们，连尚未出现在 `add()` 里的模型也不例外。
 *
 * 注意：客户端在构造时会对过滤器做一次快照，所以必须在 `newSqlClient()` **之前**
 * 注册全局过滤器；之后再注册不会生效。
 */
export function createGlobalFilterManager(): GlobalFilterManager {
  const manager = new FilterManager() as GlobalFilterManager
  const globalFilters: GlobalFilter[] = []

  const originalToMap = (manager as unknown as FilterMapCarrier)._toMap.bind(manager)

  Object.defineProperty(manager, '_toMap', {
    configurable: true,
    writable: true,
    value: () => {
      const base = originalToMap() ?? new Map<spi.Entity, ReadonlyArray<AnyFilter>>()
      return new Proxy(base, {
        get(target, property) {
          if (property === 'get') {
            return (entity: spi.Entity): ReadonlyArray<AnyFilter> => [
              ...globalFilters,
              ...(target.get(entity) ?? []),
            ]
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? (value as CallableFunction).bind(target) : value
        },
      })
    },
  })

  Object.defineProperty(manager, 'addGlobal', {
    value(filter: GlobalFilter | undefined) {
      if (filter != null) {
        globalFilters.push(filter)
      }
      return manager
    },
  })

  Object.defineProperty(manager, 'globalFilters', {
    get: () => [...globalFilters],
  })

  return manager
}
