import { prop, spi } from '@ts-grm/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyPatches } from '../src/index'

interface PropInternals {
  __data: Record<string, unknown>
}

/** 读取上游私有的 prop 定义数据（运行时是普通自有属性）。 */
function propData(value: unknown): Record<string, unknown> {
  return (value as PropInternals).__data
}

describe('applyPatches', () => {
  beforeEach(() => {
    applyPatches()
  })

  it('给标量 prop 安装 autoIncrement / default（类型与运行时同时可用）', () => {
    const patched = prop.i32()
    expect(typeof patched.autoIncrement).toBe('function')
    expect(typeof patched.default).toBe('function')
  })

  it('autoIncrement() 返回新实例，不修改原实例', () => {
    const base = prop.i32()
    const patched = base.autoIncrement()

    expect(patched).not.toBe(base)
    expect(propData(patched).autoIncrement).toBe(true)
    expect(propData(base).autoIncrement).toBeUndefined()
  })

  it('default() 记录默认值，且可与 autoIncrement 链式组合', () => {
    const patched = prop.str(64).default('pending')
    expect(propData(patched).default).toBe('pending')

    const combined = prop.i32().autoIncrement().default(0)
    expect(propData(combined).autoIncrement).toBe(true)
    expect(propData(combined).default).toBe(0)
  })

  it('保留上游子类，不退化为基类', () => {
    expect(prop.str(64).autoIncrement().constructor.name).toBe('__StrProp')
    expect(prop.i64().autoIncrement().constructor.name).toBe('__I64Prop')
    expect(prop.i32().default(1).constructor.name).toBe('__ScalarProp')
  })

  it('不污染共享的空定义数据', () => {
    const patched = prop.i32().default(7)
    expect(propData(prop.i32()).default).toBeUndefined()
    expect(propData(patched).default).toBe(7)
  })

  it('重复调用是幂等的（不重复定义方法）', () => {
    const first = prop.i32().autoIncrement
    applyPatches()
    applyPatches()
    expect(prop.i32().autoIncrement).toBe(first)
  })

  it('EntityProp 能读出 autoIncrement / default', () => {
    const entityProp = Object.create(spi.EntityProp.prototype) as {
      _data: Record<string, unknown>
      autoIncrement: boolean
      default: unknown
    }
    entityProp._data = { autoIncrement: true, default: 5 }

    expect(entityProp.autoIncrement).toBe(true)
    expect(entityProp.default).toBe(5)
  })

  it('未声明补丁的列默认为非自增、无默认值', () => {
    const entityProp = Object.create(spi.EntityProp.prototype) as {
      _data: Record<string, unknown>
      autoIncrement: boolean
      default: unknown
    }
    entityProp._data = {}

    expect(entityProp.autoIncrement).toBe(false)
    expect(entityProp.default).toBeUndefined()
  })
})
