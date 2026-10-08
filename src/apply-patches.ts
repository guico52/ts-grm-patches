import { __ScalarProp, spi } from '@ts-grm/core'

import type { ColumnDefaultValue, ColumnPatchData } from './types'

let applied = false

interface PropDataCarrier {
  __data: ColumnPatchData & Record<string, unknown>
  constructor: new (data: unknown) => PropDataCarrier
}

interface EntityPropCarrier {
  _data?: ColumnPatchData
}

/**
 * 幂等安装：上游若已原生提供同名成员，则补丁让位，不覆盖。
 */
function defineOnce(target: object, key: string, descriptor: PropertyDescriptor): void {
  if (key in target) {
    return
  }
  Object.defineProperty(target, key, descriptor)
}

/**
 * 声明侧：给标量 prop 加上 `autoIncrement()` / `default(value)`。
 *
 * 与上游 `nullable()` 同构 —— 复制 `__data` 得到新实例，因此不修改原 prop，
 * 且新实例经 `model(...)` 构建后会把这个字段原样带进 `EntityProp._data`。
 * 使用 `this.constructor` 以保留 `__StrProp` / `__I64Prop` 等子类。
 */
function installScalarModifiers(): void {
  const proto = __ScalarProp.prototype as unknown as object

  defineOnce(proto, 'autoIncrement', {
    value(this: PropDataCarrier) {
      return new this.constructor({ ...this.__data, autoIncrement: true })
    },
    writable: true,
    configurable: true,
  })

  defineOnce(proto, 'default', {
    value(this: PropDataCarrier, value: ColumnDefaultValue) {
      return new this.constructor({ ...this.__data, default: value })
    },
    writable: true,
    configurable: true,
  })
}

/**
 * 元数据侧：让 `ColumnDef.prop` 能读出列级信息。
 *
 * `EntityProp` 直接持有 DSL 层的 `__PropData`，所以这里只需要读 `_data`。
 */
function installMetadataReaders(): void {
  const proto = spi.EntityProp.prototype as unknown as object

  defineOnce(proto, 'autoIncrement', {
    get(this: EntityPropCarrier) {
      return this._data?.autoIncrement === true
    },
    configurable: true,
  })

  defineOnce(proto, 'default', {
    get(this: EntityPropCarrier) {
      return this._data?.default
    },
    configurable: true,
  })
}

/**
 * 应用补丁（幂等）。
 *
 * 必须在创建任何 `model(...)` 定义之前调用一次。
 */
export function applyPatches(): void {
  if (applied) {
    return
  }
  applied = true
  installScalarModifiers()
  installMetadataReaders()
}
