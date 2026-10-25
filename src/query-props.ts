import { err, spi } from '@ts-grm/core'

/**
 * 查询侧：让 `prop.bool()` / `prop.text()` 列能进入查询表达式（`where` / `orderBy` / `select`）。
 *
 * 上游 0.0.13 的 `createTableProp`（`packages/core/src/impl/ast/prop_expr.ts`）只为数值、
 * `STR`、`DATETIME` 建立属性表达式，`BOOL` 与 `TEXT` 落到 `default` 分支，抛出
 * `ArgumentError: Cannot create table prop for "..." whose scalar type is BOOL/TEXT`。
 *
 * `createTableProp` 是模块内部函数，无法从外部替换；但它的唯一调用者是
 * `Entity.tableClass()` 生成的表类 getter，而 `spi.Entity` 是公开导出的。
 * 因此这里在 `tableClass()` 返回后，给 `BOOL` / `TEXT` 属性的 getter 套一层：
 *
 * - **先调用上游 getter**；上游能建出表达式（即上游已修复）时原样返回，补丁完全让位；
 * - 只有上游抛出 `ArgumentError` 时，才改用本补丁的属性表达式；其他错误照常抛出。
 *
 * 范围：实体表上直接声明的标量属性。嵌入字段（embedded）内的属性与关联表
 * （中间实体）上的属性不在本补丁范围内。
 */

/** 本补丁接管的标量类型。 */
const PATCHED_KINDS = new Set(['BOOL', 'TEXT'])

/** 标记已处理过的表类，`tableClass()` 每次返回同一个缓存类，只需处理一次。 */
const patchedClasses = new WeakSet<object>()

/** 与上游 `PropStrExpr` 等同构：渲染只依赖 `table` 与 `prop`，经 `visitPropExpr` 输出列。 */
class PropBoolExpr extends spi.AbstractCmpExpr<boolean> implements spi.PropExprContract {
  readonly isAssociation = false

  constructor(
    readonly table: spi.AbstractEntityTable,
    readonly prop: spi.EntityProp,
  ) {
    super()
  }

  override get scalarProvider() {
    return this.prop.scalarProvider
  }

  override get explicitDataType() {
    return this.prop.explicitDataType
  }

  override get isPropExpr(): boolean {
    return true
  }

  override accept(visitor: spi.Visitor): void {
    visitor.visitPropExpr(this)
  }
}

/** `TEXT` 列：与 `STR` 一样提供 `eq` / `like` / `lower()` 等字符串表达式。 */
class PropTextExpr extends spi.AbstractStrExpr implements spi.PropExprContract {
  readonly isAssociation = false

  constructor(
    readonly table: spi.AbstractEntityTable,
    readonly prop: spi.EntityProp,
  ) {
    super()
  }

  override get scalarProvider() {
    return this.prop.scalarProvider
  }

  override get explicitDataType() {
    return this.prop.explicitDataType
  }

  override get isPropExpr(): boolean {
    return true
  }

  override accept(visitor: spi.Visitor): void {
    visitor.visitPropExpr(this)
  }
}

function createPropExpr(
  table: spi.AbstractEntityTable,
  prop: spi.EntityProp,
): spi.PropExprContract {
  // 与上游一致：属性表达式绑定到声明该属性的实体所在的表（继承时可能是父表）。
  const directTable = table.__to(prop.declaringEntity)
  return prop.scalarType?.kind === 'BOOL'
    ? new PropBoolExpr(directTable, prop)
    : new PropTextExpr(directTable, prop)
}

/** 上游 `createTableProp` 在 `switch` 的 `default` 分支抛出的错误（消息见本文件开头）。 */
function isUnsupportedScalarError(error: unknown): boolean {
  return error instanceof err.ArgumentError && error.message.includes('whose scalar type is')
}

/**
 * 包装一个上游 getter：上游成功则让位；只有上游因「不支持该标量类型」抛 `ArgumentError`
 * 时才改用 `fallback`。同类错误的其他原因（如属性不属于该表）照常抛出，不被补丁掩盖。
 *
 * 单独导出供测试验证"上游修复后自动让位"，不从包入口导出。
 */
export function yieldingGetter<TThis, TValue>(
  upstream: (this: TThis) => TValue,
  fallback: (self: TThis) => TValue,
): (this: TThis) => TValue {
  return function (this: TThis): TValue {
    try {
      return upstream.call(this)
    } catch (error) {
      if (!isUnsupportedScalarError(error)) {
        throw error
      }
    }
    return fallback(this)
  }
}

/** 生成的表类把属性表达式缓存在同名下划线字段上（见上游 `writeScalarProp`）。 */
type TableInstance = spi.AbstractEntityTable & Record<string, unknown>

/** `Entity.tableClass()` 返回的表类构造器（上游未导出该类型名）。 */
type EntityTableCtor = ReturnType<spi.Entity['tableClass']>

function patchTableClass(entity: spi.Entity, ctor: EntityTableCtor): void {
  if (patchedClasses.has(ctor)) {
    return
  }
  patchedClasses.add(ctor)
  for (const prop of entity.declaredPropMap.values()) {
    if (prop.parentProp !== undefined || !PATCHED_KINDS.has(prop.scalarType?.kind ?? '')) {
      continue
    }
    const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, prop.name)
    const upstream = descriptor?.get
    if (upstream === undefined) {
      continue
    }
    const field = `_${prop.name}`
    Object.defineProperty(ctor.prototype, prop.name, {
      ...descriptor,
      get: yieldingGetter<TableInstance, unknown>(upstream, (self) => {
        // 写入上游同一个缓存字段：之后上游 getter 会直接返回缓存，不再抛错。
        let expr = self[field]
        if (expr == null) {
          self[field] = expr = createPropExpr(self, prop)
        }
        return expr
      }),
    })
  }
}

/** 安装查询侧补丁（由 `applyPatches()` 调用一次）。 */
export function installQueryProps(): void {
  const proto = spi.Entity.prototype
  const upstream = proto.tableClass
  proto.tableClass = function (this: spi.Entity): EntityTableCtor {
    const ctor = upstream.call(this)
    patchTableClass(this, ctor)
    return ctor
  }
}
