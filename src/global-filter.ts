import { spi } from '@ts-grm/core'
import type { AnyModel, Predicate, SqlClient } from '@ts-grm/core'
import type { AnyFilter } from '@ts-grm/sql'

/**
 * 对所有模型生效的过滤器。
 *
 * 与上游 per-model 的 `Filter` 同形。过滤器收到的 table 是上游查询期对象，
 * 其 `__entity` 指向当前的 `spi.Entity`。
 */
export type GlobalFilter = AnyFilter

export interface GlobalFilterManager {
  /**
   * 注册一个对**所有**模型生效的过滤器。
   *
   * 因为无法预知过滤器内部的逻辑，这种方式会被视为「对所有实体都适用」，
   * 从而让 `getFilters(entity)` 恒为非空 —— 上游据此判断关联查询能否直接读取
   * 外键（`association_resolver.ts` 的 `length === 0`），因此会放弃该优化。
   * 需要按列过滤时请用 `addGlobalFor()`，它只在适用实体上返回过滤器。
   *
   * 注意：上游的 table 是按实体的声明属性逐个生成的，**不含该列的模型上属性为
   * `undefined`**，直接 `table.xxx.eq(...)` 会抛 `TypeError` 并打断查询。
   * 必须自行守卫，例如 `(table) => table.tenantId?.eq(id)`。
   */
  addGlobal(filter: GlobalFilter | undefined): this

  /**
   * 声明式注册：**只在模型确实拥有该列时**才应用过滤器。
   *
   * 与 `addGlobal()` 不同，适用性在 `getFilters(entity)` 阶段就按实体元数据判定：
   * 缺少该列的实体**拿不到这个过滤器**，因此返回空数组，上游的关联查询优化得以保留；
   * 过滤器执行时也会再检查一次列是否存在，缺列时返回 `undefined`（上游会忽略）。
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
   * 列名写错时该过滤器会在所有模型上静默失效，这里让它可以被显式检查。
   */
  unknownColumns(models: ReadonlyArray<AnyModel>): ReadonlyArray<string>
}

interface FiltersHolder {
  getFilters(entity: spi.Entity): ReadonlyArray<AnyFilter>
}

interface CompiledGlobalFilter {
  readonly filter: GlobalFilter
  /** `undefined` 表示「总是适用」。 */
  readonly appliesTo: ((entity: spi.Entity) => boolean) | undefined
}

interface ManagerState {
  readonly compiled: CompiledGlobalFilter[]
  readonly columns: string[]
}

/** 同一个 client 只包装一次，重复安装返回同一个管理器。 */
const managerByClient = new WeakMap<SqlClient, GlobalFilterManager>()
const stateByManager = new WeakMap<GlobalFilterManager, ManagerState>()

const columnPresenceCache = new WeakMap<spi.Entity, Map<string, boolean>>()

/**
 * 判断实体的 table 上是否存在该列。
 *
 * 与上游生成 table 字段的依据同源（实体的声明属性），并用 WeakMap 缓存；
 * 判断不出来时**倾向于适用** —— 过滤器执行时还有一次存在性检查兜底。
 */
function hasColumn(entity: spi.Entity, column: string): boolean {
  let byColumn = columnPresenceCache.get(entity)
  if (byColumn == null) {
    byColumn = new Map()
    columnPresenceCache.set(entity, byColumn)
  }
  const cached = byColumn.get(column)
  if (cached != null) {
    return cached
  }

  let result: boolean
  try {
    const ctor = (
      entity as unknown as {
        tableClass(): new (e: spi.Entity, join: unknown) => object
      }
    ).tableClass()
    result = column in new ctor(entity, undefined)
  } catch {
    result = true
  }
  byColumn.set(column, result)
  return result
}

function createManager(): GlobalFilterManager {
  const state: ManagerState = { compiled: [], columns: [] }

  const manager: GlobalFilterManager = {
    addGlobal(filter: GlobalFilter | undefined) {
      if (filter != null) {
        state.compiled.push({ filter, appliesTo: undefined })
      }
      return this
    },
    addGlobalFor<TColumn>(column: string, build: (column: TColumn) => Predicate | undefined) {
      if (!state.columns.includes(column)) {
        state.columns.push(column)
      }
      state.compiled.push({
        filter: (table) => {
          const onTable = (table as unknown as Record<string, unknown>)[column]
          if (onTable == null) {
            // 该模型没有这一列：跳过而不是抛错
            return undefined
          }
          return build(onTable as TColumn)
        },
        appliesTo: (entity) => hasColumn(entity, column),
      })
      return this
    },
    get globalFilters() {
      return state.compiled.map((c) => c.filter)
    },
    unknownColumns(models: ReadonlyArray<AnyModel>) {
      return state.columns.filter(
        (column) => !models.some((m) => spi.Entity.of(m as never).declaredPropMap.has(column)),
      )
    },
  }

  stateByManager.set(manager, state)
  return manager
}

function attach(client: SqlClient, state: ManagerState): void {
  const holder = client as unknown as Partial<FiltersHolder>
  if (typeof holder.getFilters !== 'function') {
    throw new Error(
      'installGlobalFilters(): the SqlClient does not expose getFilters(); ' +
        'the installed @ts-grm/sql is not supported by this patch version.',
    )
  }

  const original = holder.getFilters.bind(client)

  holder.getFilters = (entity: spi.Entity) => {
    const own = original(entity)
    const applicable = state.compiled.filter((c) => c.appliesTo == null || c.appliesTo(entity))
    if (applicable.length === 0) {
      // 关键：保持上游「空数组」的语义，不要破坏关联查询的直接读外键优化
      return own
    }
    return [...applicable.map((c) => c.filter), ...own]
  }
}

/**
 * 让 client 具备全局过滤器能力。
 *
 * 上游 `FilterManager.add()` 必须绑定具体模型，没有「对所有模型生效」的能力，
 * 因此这里在公开接口 `getFilters(entity)` 上叠加 —— 它是 `SqlClientImplementor`
 * 的成员（受 semver 保护），入参就是原始实体。
 *
 * 对同一个 client 重复调用是幂等的（返回同一个管理器）。上游的
 * `newSqlClient(client, options)` 会**新建实例**、不会继承本包装：派生客户端需要
 * 再次调用本函数，并把自己原作 manager 传进来以共享同一批过滤器：
 *
 * ```ts
 * const derived = newSqlClient(client, { ... })
 * installGlobalFilters(derived, manager)
 * ```
 */
export function installGlobalFilters(
  client: SqlClient,
  manager?: GlobalFilterManager,
): GlobalFilterManager {
  const existing = managerByClient.get(client)
  if (existing != null) {
    return existing
  }

  const target = manager ?? createManager()
  const state = stateByManager.get(target)
  if (state == null) {
    throw new Error('installGlobalFilters(): the given manager was not created by this package.')
  }

  attach(client, state)
  managerByClient.set(client, target)
  return target
}
