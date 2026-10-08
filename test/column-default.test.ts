import { dsl, prop } from '@ts-grm/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyPatches, isColumnDefaultExpression } from '../src/index'

function propData(value: unknown): Record<string, unknown> {
  return (value as { __data: Record<string, unknown> }).__data
}

describe('column default', () => {
  beforeEach(() => {
    applyPatches()
  })

  it('接受与列类型一致的字面量', () => {
    expect(propData(prop.i32().default(0)).default).toBe(0)
    expect(propData(prop.str(20).default('active')).default).toBe('active')
    expect(propData(prop.bool().default(false)).default).toBe(false)
  })

  it('接受 SQL 表达式（dsl.native）', () => {
    const now = dsl.native.date`now()`
    expect(propData(prop.dt().default(now)).default).toBe(now)
  })

  it('字面量与表达式都可与 autoIncrement 链式组合', () => {
    const patched = prop.i32().autoIncrement().default(0)
    expect(propData(patched).autoIncrement).toBe(true)
    expect(propData(patched).default).toBe(0)
  })

  describe('isColumnDefaultExpression', () => {
    it('识别表达式节点', () => {
      expect(isColumnDefaultExpression(dsl.native.date`now()`)).toBe(true)
      expect(isColumnDefaultExpression(dsl.native.str`uuid_generate_v4()`)).toBe(true)
      expect(isColumnDefaultExpression(dsl.native.num`1`)).toBe(true)
    })

    it('不把字面量当成表达式', () => {
      expect(isColumnDefaultExpression('active')).toBe(false)
      expect(isColumnDefaultExpression(0)).toBe(false)
      expect(isColumnDefaultExpression(false)).toBe(false)
      expect(isColumnDefaultExpression(0n)).toBe(false)
    })

    it('安全处理 undefined / null / 普通对象', () => {
      expect(isColumnDefaultExpression(undefined)).toBe(false)
      expect(isColumnDefaultExpression(null as never)).toBe(false)
      expect(isColumnDefaultExpression({} as never)).toBe(false)
      expect(isColumnDefaultExpression({ __type: 'not-a-function' } as never)).toBe(false)
    })
  })
})
